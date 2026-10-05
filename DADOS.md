# Organização dos dados do P'Clube

O servidor mantém os dados em JSON separados por domínio dentro de `dados/`:

- `dados/usuarios/usuarios.json`: perfis, data do último login (`last_login_at`), último acesso (`last_seen_at`), molduras de avatar, opções visuais da moldura e hashes de senha. Senhas em texto puro não são armazenadas.
- `dados/biblioteca/episodios.json` e `dados/biblioteca/doramas.json`: episódios, progresso, minutos salvos, acompanhamento automático de reprodução e conclusão de doramas.
- `dados/mensagens/mensagens.json`: mensagens do grupo geral; mensagens privadas legadas não são exibidas nem aceitas em novos envios.
- `dados/recomendacoes/recomendacoes.json`: recomendações entre membros.
- `dados/sessoes/assistir-juntos.json`: convites individuais e salas sincronizadas abertas ao grupo. Salas do grupo permanecem disponíveis para entrada até a pessoa que abriu a sala encerrá-la; membros podem entrar ou ignorar o aviso.
- `dados/notificacoes/atividade.json`: histórico compartilhado de atividades do clube. Limpar notificações apenas as oculta para o membro; não apaga mensagens nem o histórico de atividades.
- `dados/usuarios/usuarios.json`: também guarda, por usuário, as preferências de notificações, silenciamento do grupo, cor do balão e marcadores de leitura/limpeza; a API expõe a preferência de silenciamento apenas para a própria conta.
- `dados/fotos/perfis/`, `dados/fotos/capas/`, `dados/fotos/elementos/` e `dados/fotos/chat/`: fotos de perfil, capas, elementos PNG transparentes usados nas molduras e anexos do bate-papo, respectivamente.
- `dados/configuracao.json`: versão do formato dos arquivos.
- `dados/migracao/`: cópia do arquivo legado `usuarios.json` após a migração automática.

Na primeira inicialização com a estrutura nova, o servidor migra automaticamente o conteúdo do `usuarios.json` legado, preserva seus registros, separa as imagens e arquiva o arquivo original. Os arquivos dentro de `dados/` contêm informações privadas e não devem ser publicados ou servidos como arquivos estáticos.

Comentários de episódios e doramas ficam junto aos respectivos registros da biblioteca. O autor pode editar o próprio comentário por até dois minutos após a criação e pode apagá-lo; essas ações são registradas no histórico de atividades. As rotas autenticadas são `PUT`/`DELETE /api/episodes/:episodeId/comments/:commentId` e `PUT`/`DELETE /api/series/:seriesName/comments/:commentId`. As preferências são atualizadas por `POST /api/notifications/preferences`; categorias desativadas deixam de aparecer no sino, mas as atividades continuam no Portal.

A personalização do avatar fica nos campos `avatar_frame`, `avatar_frame_color`, `avatar_frame_element`, `avatar_frame_element_position` e `avatar_frame_element_size` do perfil. O elemento é enviado como PNG com transparência e servido autenticadamente em `/media/elementos/`. Abrir um episódio marca automaticamente o acompanhamento ativo; heartbeats mantêm o estado enquanto a página de reprodução está aberta, e fechar/navegar para longe registra o último assistido. Cada progresso por episódio guarda `is_watching`, `watching_updated`, `last_opened`, `last_watched` e, quando informado, `last_position_seconds`. Concluir um dorama registra o membro em `finished_by` e marca seus episódios como assistidos.

O status online usa heartbeats autenticados; após 45 segundos sem heartbeat o membro é tratado como offline. O campo `last_seen_at` é atualizado também ao sair ou encerrar a sessão. O bate-papo tem uma sala geral: mensagens incluem texto, marcações validadas no servidor e até três anexos por envio (imagens JPG/PNG/WebP/GIF, PDF, TXT e DOCX), limitados a 2 MiB cada e 4 MiB no total; os arquivos são servidos por rota autenticada e nomes em disco usam hash SHA-256. O silenciamento pessoal suprime notificações de mensagens sem marcação, mas nunca as notificações `@`. Cada perfil pode personalizar a cor do balão, exibição da borda e cor da borda; essas opções validadas são gravadas em cada mensagem. O limite de armazenamento combinado de mensagens, anexos e solicitações é configurado pela variável `PCLUBE_CHAT_STORAGE_LIMIT_BYTES` (padrão: 50 MiB). A interface avisa a partir de 80% e bloqueia novos envios quando o limite é alcançado; a limpeza remove mensagens antigas, anexos sem referência e sessões encerradas para todos os membros.
