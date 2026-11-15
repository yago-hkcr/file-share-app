// Transporte resumível do Google Drive.
//
// Quando o servidor libera uma sessão direta (CORS aberto para a origem do
// site), o navegador envia os blocos direto ao Google e o servidor deixa de
// intermediar bytes. Se o navegador bloquear a origem, o primeiro bloco falha e
// o envio continua pelo servidor, sem o usuário perceber.
//
// Caminho rápido: sessão recém-criada não pergunta a posição (já é 0), o último
// bloco devolve o ID do arquivo e o registro no banco fecha o upload sem nenhuma
// chamada extra ao Google.
export async function uploadDriveFile(session, file, {
  onProgress = () => {}, signal, onSessionChange = () => {}, fresh = false, fetchImpl = fetch
} = {}) {
  const abortError = () => {
    const error = new Error('Envio cancelado.');
    error.name = 'AbortError';
    return error;
  };
  const assertNotAborted = () => { if (signal && signal.aborted) throw abortError(); };
  const endpoint = (current, action) => '/api/google-drive/uploads/' + encodeURIComponent(current.upload_id) + '/' + action;
  const directSession = current => (current && current.direct && typeof current.direct.session_url === 'string'
    ? current.direct.session_url : '');
  let directBlocked = false;
  let directVerified = false;

  const readStatus = async current => {
    assertNotAborted();
    const response = await fetchImpl(endpoint(current, 'status'), {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: '{}', signal
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && data.state === 'account_changed' && data.session && data.session.upload_id) {
      return { accountChanged: true, session: data.session };
    }
    if (!response.ok) {
      const error = new Error(data.error || 'Não foi possível confirmar o estado do envio ao Google Drive.');
      if (response.status === 429 || response.status === 410) error.retryable = response.status === 429;
      throw error;
    }
    if (data.complete) return { complete: true, offset: file.size };
    const offset = Number(data.next_offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) {
      throw new Error('O Google Drive retornou uma posição de envio inválida.');
    }
    return { complete: false, offset };
  };

  // Lê "bytes=0-123" do cabeçalho Range e devolve o próximo byte confirmado.
  const rangeOffset = (response, fallback, minimum) => {
    const header = response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('Range') : null;
    const match = header && /bytes=\d+-(\d+)/i.exec(header);
    if (!match) return fallback;
    const next = Number(match[1]) + 1;
    if (!Number.isSafeInteger(next) || next < minimum || next > fallback) return fallback;
    return next;
  };

  // Retorna { complete, fileId } quando o Google aceita o bloco, { retry: true }
  // para repetir o mesmo bloco e { fallback: true } quando o envio direto não é
  // possível.
  const sendDirectChunk = async (current, offset, end, attempt, verified) => {
    assertNotAborted();
    const url = directSession(current);
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'PUT',
        headers: { 'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + file.size },
        body: file.slice(offset, end), signal
      });
    } catch (error) {
      if (signal && signal.aborted) throw abortError();
      // Queda de rede momentânea: repetir o mesmo bloco é seguro (o Google
      // ignora bytes já recebidos) e evita uma consulta de estado no servidor.
      // Só repete se o caminho direto já funcionou antes; na primeira tentativa
      // o erro costuma ser CORS e insistir só atrasaria o fallback.
      return attempt < 1 && verified ? { retry: true } : { fallback: true };
    }
    directVerified = true;
    if (response.status === 308) return { offset: rangeOffset(response, end, offset) };
    if (response.ok) {
      const body = await response.json().catch(() => null);
      return { complete: true, fileId: body && body.id ? String(body.id) : '' };
    }
    // 401/403/404/410: sessão ou CORS inválidos; 5xx pode ser repetido pelo
    // servidor. Em ambos os casos o caminho pelo servidor assume.
    return { fallback: true };
  };

  let current = session;
  onSessionChange(current);
  // Sessão recém-criada começa no byte 0: nada de ida e volta antes do
  // primeiro byte. Sessões retomadas consultam o estado real.
  let state = fresh ? { complete: false, offset: 0 } : await readStatus(current);
  let unchangedRetries = 0;

  while (true) {
    assertNotAborted();
    if (state.accountChanged) {
      current = state.session;
      onSessionChange(current);
      onProgress(0);
      // Sessão nova em outra conta: também recomeça do zero, sem consulta.
      state = { complete: false, offset: 0 };
      continue;
    }
    if (state.complete) { onProgress(100); return { complete: true, fileId: '' }; }
    const offset = state.offset;
    if (offset === file.size) {
      const confirmation = await readStatus(current);
      if (confirmation.complete) { onProgress(100); return { complete: true, fileId: '' }; }
      if (confirmation.accountChanged || confirmation.offset !== file.size) {
        state = confirmation;
        continue;
      }
      throw new Error('O Google Drive recebeu todos os bytes, mas ainda não confirmou a conclusão do upload.');
    }

    // 1) Caminho direto (navegador -> Google), quando disponível.
    if (!directBlocked && directSession(current)) {
      const directChunk = Math.max(256 * 1024, Number(current.direct.chunk_bytes) || 16 * 1024 * 1024);
      const directEnd = Math.min(offset + directChunk, file.size);
      let result = await sendDirectChunk(current, offset, directEnd, 0, directVerified);
      if (result && result.retry) result = await sendDirectChunk(current, offset, directEnd, 1, directVerified);
      if (result && result.complete) {
        // O registro no banco confirma o arquivo pelo ID devolvido aqui; não é
        // preciso consultar o servidor de novo.
        onProgress(100);
        return { complete: true, fileId: result.fileId || '' };
      }
      if (result && typeof result.offset === 'number') {
        state = { complete: false, offset: result.offset };
        unchangedRetries = 0;
        onProgress(Math.round(result.offset / file.size * 100));
        continue;
      }
      // Falhou: o servidor continua de onde o Google confirmou.
      directBlocked = true;
      const reconciled = await readStatus(current).catch(() => null);
      if (reconciled && reconciled.accountChanged) { state = reconciled; continue; }
      if (reconciled && reconciled.complete) { onProgress(100); return { complete: true, fileId: '' }; }
      if (reconciled) state = reconciled;
      continue;
    }

    // 2) Caminho pelo servidor (fallback e padrão histórico).
    const end = Math.min(offset + (Number(current.chunk_bytes) || 4 * 1024 * 1024), file.size);
    let response;
    let data;
    try {
      response = await fetchImpl(endpoint(current, 'chunk'), {
        method: 'POST', credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + file.size
        },
        body: file.slice(offset, end), signal
      });
      data = await response.json().catch(() => ({}));
    } catch (error) {
      if (signal && signal.aborted) throw abortError();
      // A resposta pode se perder após aceitação do bloco. O status remoto é
      // consultado antes de qualquer retry para evitar repetição insegura.
      const reconciled = await readStatus(current);
      if (reconciled.accountChanged || reconciled.complete || reconciled.offset !== offset) {
        state = reconciled;
        unchangedRetries = 0;
        onProgress(reconciled.complete ? 100 : Math.round(reconciled.offset / file.size * 100));
        continue;
      }
      unchangedRetries++;
      if (unchangedRetries > 2) throw error;
      state = reconciled;
      continue;
    }

    if (response.status === 409 && data.state === 'account_changed' && data.session && data.session.upload_id) {
      current = data.session;
      onSessionChange(current);
      directBlocked = false;
      onProgress(0);
      state = { complete: false, offset: 0 };
      unchangedRetries = 0;
      continue;
    }
    if (!response.ok) {
      const error = new Error(data.error || 'Falha ao enviar bloco ao Google Drive.');
      if (response.status < 500) throw error;
      const reconciled = await readStatus(current);
      if (!reconciled.accountChanged && !reconciled.complete && reconciled.offset === offset) throw error;
      state = reconciled;
      unchangedRetries = 0;
      continue;
    }
    if (data.complete) { onProgress(100); return { complete: true, fileId: '' }; }

    const nextOffset = Number(data.next_offset);
    if (!Number.isSafeInteger(nextOffset) || nextOffset < offset || nextOffset > end) {
      const reconciled = await readStatus(current);
      if (!reconciled.accountChanged && !reconciled.complete && reconciled.offset === offset) {
        throw new Error('O Google Drive retornou uma posição de envio inválida.');
      }
      state = reconciled;
      unchangedRetries = 0;
      continue;
    }
    if (nextOffset === offset) {
      const reconciled = await readStatus(current);
      if (!reconciled.accountChanged && !reconciled.complete && reconciled.offset === offset) {
        throw new Error('O Google Drive não confirmou o avanço do bloco enviado.');
      }
      state = reconciled;
      unchangedRetries = 0;
      continue;
    }

    state = { complete: false, offset: nextOffset };
    unchangedRetries = 0;
    onProgress(Math.round(nextOffset / file.size * 100));
  }
}
