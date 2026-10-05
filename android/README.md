# FileShare Flutuante para Android

O aplicativo Android abre o FileShare dentro do app e pode mantê-lo numa janela interativa sobre outros aplicativos.

## Como usar

1. Instale o APK de depuração gerado pelo workflow **Android APK** em GitHub → Actions.
2. Abra **FileShare Flutuante** e entre na sua conta.
3. Toque em **Flutuar**. O Android abrirá a tela de acesso especial para permitir que o FileShare apareça sobre outros apps. Ative a permissão e volte ao FileShare.
4. A janela abre por cima. Arraste a barra de título para reposicioná-la, use o botão de expandir para alternar o tamanho ou **×** para fechar.
5. Toques fora da janela continuam chegando ao aplicativo que está por baixo. O FileShare permanece visível até fechar a janela.

A permissão é concedida pelo próprio Android em Configurações → Acesso especial → Sobrepor a outros apps e pode ser revogada a qualquer momento.

## Usar um servidor da sala

No campo de endereço, informe o IP local do computador servidor, por exemplo http://192.168.1.20:3001, e toque em **Abrir**. O celular precisa estar na mesma rede local do computador. Para voltar ao site publicado, use https://file-share-app-sable.vercel.app.

Uploads abrem o seletor de arquivos do Android e downloads usam a pasta Downloads do aparelho. A sessão do aplicativo é própria: entre uma vez pelo app, separadamente do Brave.
