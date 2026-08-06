# Fluffy Dreams

E-commerce de pelúcias com gerador de imagens por IA (Gemini + Pollinations).

## Como rodar

```bash
npm install
npm start        # sobe o servidor em http://localhost:3000
```

O `.env` (na raiz) guarda as chaves do banco PostgreSQL, do Gemini e o segredo do JWT.

## Estrutura do projeto

```
LABUBU/
├── api/                  ← Backend (servidor Node.js + banco de dados)
│   ├── servidor.js       ← Todas as rotas da API + integração com as IAs
│   ├── banco.js          ← Conexão com o PostgreSQL
│   └── middleware.js     ← Autenticação (token JWT)
├── site/                 ← Frontend (o que o navegador carrega)
│   ├── paginas/          ← As páginas do site (.html)
│   │   ├── inicio.html           (loja/catálogo)
│   │   ├── criar-pelucia.html    (gerador de pelúcia com IA)
│   │   ├── carrinho.html
│   │   ├── produto.html
│   │   ├── meus-pedidos.html
│   │   ├── entrar.html           (login)
│   │   ├── cadastro.html
│   │   └── administracao.html
│   ├── estilos/          ← CSS (estilos.css)
│   ├── scripts/          ← JavaScript do navegador (script.js, configuracao.js)
│   └── imagens/          ← banner e fotos dos produtos
├── dados/                ← Arquivos gerados (não vai para o git)
│   ├── pelucias-geradas/ ← Imagens criadas pela IA
│   └── estilo-home.txt   ← Cache do estilo visual das pelúcias
├── .env                  ← Chaves secretas (não vai para o git)
└── package.json          ← Dependências e comandos
```

## Fluxo principal (compra)

1. O navegador (JavaScript em `site/scripts/script.js`) chama a API em `api/servidor.js`.
2. O servidor consulta o PostgreSQL (`api/banco.js`) e devolve a resposta.
3. O carrinho é um "pedido ABERTO" no banco; ao finalizar, vira FINALIZADO/ENTREGUE.

## Fluxo do gerador de pelúcia (IA)

1. `site/paginas/criar-pelucia.html` envia a ideia para `POST /generate`.
2. `api/servidor.js` usa o **Gemini** para criar o prompt e o nome da pelúcia.
3. A imagem é gerada pelo **Pollinations** e conferida pelo Gemini (não pode ter humanos).
4. A imagem é salva em `dados/pelucias-geradas/` e mostrada ao usuário.
5. A negociação (`POST /generate/negociar`) transforma a pelúcia em produto no catálogo.

## Tema claro/escuro

Botão de sol/lua no topo do site alterna o tema e salva a preferência no navegador.
