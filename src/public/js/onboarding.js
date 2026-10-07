/* FileShare onboarding for new accounts and the replayable dashboard tour. */
(function () {
  'use strict';

  const baseSteps = [
    { selector: '#roomsTab', icon: 'fa-door-open', title: 'Seu espaço de trabalho', text: 'Salas são espaços próprios para compartilhar arquivos e conversar sem misturar projetos.' },
    { selector: '#newRoomBtn', icon: 'fa-plus', optional: true, title: 'Crie uma sala', text: 'Dê um nome, escolha a duração e convide as pessoas que vão participar.' },
    { selector: '#roomsGrid', icon: 'fa-folder-open', title: 'Tudo organizado', text: 'Abra uma sala para enviar arquivos, acompanhar os envios e conversar com o grupo.' },
    { selector: '#collectionsTab', icon: 'fa-inbox', title: 'Peça arquivos com Coletas', text: 'Crie uma solicitação com prazo e itens. Cada pessoa recebe seu link e só consegue ver o próprio envio; você acompanha o andamento e baixa tudo em ZIP.' },
    { selector: '#friendsBtn', icon: 'fa-user-group', optional: true, title: 'Convide com mais rapidez', text: 'Adicione amizades à sala e selecione esses nomes diretamente ao criar uma Coleta.' },
    { selector: '.header-right', icon: 'fa-sliders', title: 'Seu perfil e preferências', text: 'Acesse configurações, altere sua senha e personalize tema, atualização e animações.' },
    { selector: '#tutorialBtn', icon: 'fa-compass', title: 'Volte quando quiser', text: 'Pronto. A bússola no topo reabre este tutorial sempre que você precisar.' }
  ];

  let overla���q�^