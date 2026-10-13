# Imagens enviadas no editor

No editor, use **Adicionar imagens** para anexar até 5 fotos JPG/PNG/WebP (até 400 KB por arquivo). As fotos são gravadas nos arquivos do projeto, com caminhos `assets/foto-...`, e entram no ZIP como arquivos binários reais.

Depois do upload, peça à IA: "Use as imagens que enviei nos produtos". O prompt passa os nomes dos arquivos ao modelo, mas a escolha e o uso correto das imagens ainda dependem da resposta da IA.

A prévia HTML substitui referências relativas `assets/...` pelas imagens salvas. Para o projeto React exportado, os caminhos `assets/...` são relativos à raiz do projeto: ajuste os caminhos para `/assets/...` após colocar as fotos na pasta `public/assets` do Vite, caso necessário.

O servidor aceita requisições JSON de até 3 MB. Para produção, prefira Supabase Storage com controle de acesso, limites e verificação de arquivos; esta implementação inicial guarda as fotos como base64 no banco de dados e no histórico de versões, aumentando seu tamanho.

Não foram executados testes de integração completos neste ambiente. Não compartilhe `.env` nem tokens.
