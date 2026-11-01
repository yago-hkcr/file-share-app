// Transporte resumível autenticado pelo servidor. A URL bearer do Drive
// permanece exclusivamente no servidor; o navegador usa apenas o ID da sessão.
export async function uploadDriveFile(session, file, {
  onProgress = () => {}, signal, onSessionChange = () => {}, fetchImpl = fetch
} = {}) {
  const abortError = () => {
    const error = new Error('Envio cancelado.');
    error.name = 'AbortError';
    return error;
  };
  const assertNotAborted = () => { if (signal && signal.aborted) throw abortError(); };
  const endpoint = (current, action) => '/api/google-drive/uploads/' + encodeURIComponent(current.upload_id) + '/' + action;

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
    if (!response.ok) throw new Error(data.error || 'Não foi possível confirmar o estado do envio ao Google Drive.');
    if (data.complete) return { complete: true, offset: file.size };
    const offset = Number(data.next_offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size) {
      throw new Error('O Google Drive retornou uma posição de envio inválida.');
    }
    return { complete: false, offset };
  };

  let current = session;
  onSessionChange(current);
  let state = await readStatus(current);
  let unchangedRetries = 0;

  while (true) {
    assertNotAborted();
    if (state.accountChanged) {
      current = state.session;
      onSessionChange(current);
      onProgress(0);
      state = await readStatus(current);
      continue;
    }
    if (state.complete) { onProgress(100); return; }
    const offset = state.offset;
    if (offset === file.size) {
      const confirmation = await readStatus(current);
      if (confirmation.complete) { onProgress(100); return; }
      if (confirmation.accountChanged || confirmation.offset !== file.size) {
        state = confirmation;
        continue;
      }
      throw new Error('O Google Drive recebeu todos os bytes, mas ainda não confirmou a conclusão do upload.');
    }

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
      onProgress(0);
      state = await readStatus(current);
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
    if (data.complete) { onProgress(100); return; }

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