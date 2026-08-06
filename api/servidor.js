require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./banco');
const { autenticar } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const JWT_EXPIRATION_MS = parseInt(process.env.JWT_EXPIRATION_MS || '3600000');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
// Site (frontend) servido da raiz: /paginas/inicio.html, /estilos/estilos.css etc.
app.use(express.static(path.join(__dirname, '..', 'site')));
// Compatibilidade de URLs das imagens salvas no banco
app.use('/images', express.static(path.join(__dirname, '..', 'site', 'imagens')));
app.use('/uploads/geradas', express.static(path.join(__dirname, '..', 'dados', 'pelucias-geradas')));

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY, nome VARCHAR(120) NOT NULL, email VARCHAR(255) NOT NULL UNIQUE,
        senha_hash TEXT NOT NULL, data_cadastro TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS produtos (
        id SERIAL PRIMARY KEY, nome VARCHAR(150) NOT NULL,
        preco DECIMAL(19,2) NOT NULL, quantidade_estoque INTEGER NOT NULL DEFAULT 0,
        descricao VARCHAR(1000), status BOOLEAN NOT NULL DEFAULT true,
        imagem VARCHAR(500), categoria VARCHAR(100)
      );
      CREATE TABLE IF NOT EXISTS pedidos (
        id SERIAL PRIMARY KEY, id_usuario INTEGER NOT NULL REFERENCES usuarios(id),
        total DECIMAL(19,2) NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'ABERTO',
        data_pedido TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        endereco_entrega TEXT, metodo_pagamento VARCHAR(50), observacoes TEXT
      );
      CREATE TABLE IF NOT EXISTS itens_pedidos (
        id SERIAL PRIMARY KEY, id_pedido INTEGER NOT NULL REFERENCES pedidos(id),
        id_produto INTEGER NOT NULL REFERENCES produtos(id),
        quantidade INTEGER NOT NULL, preco_unitario DECIMAL(19,2) NOT NULL
      );
      CREATE TABLE IF NOT EXISTS avaliacoes (
        id SERIAL PRIMARY KEY, id_produto INTEGER NOT NULL REFERENCES produtos(id),
        id_usuario INTEGER NOT NULL REFERENCES usuarios(id), nota INTEGER NOT NULL CHECK(nota>=1 AND nota<=5),
        comentario TEXT, data TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(id_produto, id_usuario)
      );
    `);
    // Migrations for existing tables
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS endereco_entrega TEXT`);
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS metodo_pagamento VARCHAR(50)`);
    await client.query(`ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS observacoes TEXT`);
    console.log('Banco inicializado');
  } finally { client.release(); }
}
initDB().catch(err => console.error('Erro ao inicializar banco:', err));

function formatPreco(row) {
  if (!row) return row;
  if (row.preco !== undefined) row.preco = Number(row.preco);
  if (row.preco_unitario !== undefined) row.preco_unitario = Number(row.preco_unitario);
  if (row.total !== undefined) row.total = Number(row.total);
  return row;
}

/* ─────────────── AUTH ─────────────── */

app.post('/auth/register', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ error: 'nome, email e senha obrigatórios' });
    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existente.rows.length > 0) return res.status(409).json({ error: 'Email já cadastrado' });
    const hash = await bcrypt.hash(senha, 10);
    const r = await pool.query('INSERT INTO usuarios (nome,email,senha_hash,data_cadastro) VALUES ($1,$2,$3,NOW()) RETURNING id,nome,email,data_cadastro', [nome, email, hash]);
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error('Erro register:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) return res.status(400).json({ error: 'email e senha obrigatórios' });
    const r = await pool.query('SELECT id,nome,email,senha_hash FROM usuarios WHERE email = $1', [email]);
    if (r.rows.length === 0) return res.status(403).json({ error: 'Credenciais inválidas' });
    if (!await bcrypt.compare(senha, r.rows[0].senha_hash)) return res.status(403).json({ error: 'Credenciais inválidas' });
    const token = jwt.sign({ id: r.rows[0].id, email: r.rows[0].email, nome: r.rows[0].nome }, JWT_SECRET, { expiresIn: Math.floor(JWT_EXPIRATION_MS / 1000) });
    res.json({ token, tipo: 'Bearer', expiraEmMs: JWT_EXPIRATION_MS });
  } catch (err) { console.error('Erro login:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/auth/me', autenticar, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,nome,email,data_cadastro FROM usuarios WHERE id = $1', [req.usuarioId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json(r.rows[0]);
  } catch (err) { console.error('Erro me:', err); res.status(500).json({ error: 'Erro interno' }); }
});

/* ─────────────── PRODUTOS ─────────────── */

app.get('/categorias', async (req, res) => {
  try {
    const r = await pool.query('SELECT DISTINCT categoria FROM produtos WHERE status = true AND categoria IS NOT NULL ORDER BY categoria');
    res.json(r.rows.map(c => c.categoria));
  } catch (err) { console.error('Erro categorias:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/produtos', async (req, res) => {
  try {
    const { nome, status, categoria, limit: qlimit, offset } = req.query;
    let sql = 'SELECT id,nome,preco,quantidade_estoque,descricao,status,imagem,categoria FROM produtos WHERE 1=1';
    const params = [];
    if (nome) { params.push(`%${nome}%`); sql += ` AND LOWER(nome) LIKE LOWER($${params.length})`; }
    if (categoria) { params.push(categoria); sql += ` AND categoria = $${params.length}`; }
    if (status !== undefined) { params.push(status === 'true'); sql += ` AND status = $${params.length}`; }
    sql += ' ORDER BY id';
    if (qlimit) { params.push(parseInt(qlimit)); sql += ` LIMIT $${params.length}`; }
    if (offset) { params.push(parseInt(offset)); sql += ` OFFSET $${params.length}`; }
    const r = await pool.query(sql, params);
    res.json(r.rows.map(formatPreco));
  } catch (err) { console.error('Erro listar produtos:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/produtos/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,nome,preco,quantidade_estoque,descricao,status,imagem,categoria FROM produtos WHERE id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro buscar produto:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/produtos', autenticar, async (req, res) => {
  try {
    const { nome, preco, quantidadeEstoque, descricao, status, imagem, categoria } = req.body;
    if (!nome || preco === undefined) return res.status(400).json({ error: 'nome e preco obrigatórios' });
    const r = await pool.query('INSERT INTO produtos (nome,preco,quantidade_estoque,descricao,status,imagem,categoria) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [nome, preco, quantidadeEstoque ?? 0, descricao ?? null, status ?? true, imagem ?? null, categoria ?? null]);
    res.status(201).json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro criar produto:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.put('/produtos/:id', autenticar, async (req, res) => {
  try {
    const { nome, preco, quantidadeEstoque, descricao, status, imagem, categoria } = req.body;
    if (!nome || preco === undefined) return res.status(400).json({ error: 'nome e preco obrigatórios' });
    const r = await pool.query('UPDATE produtos SET nome=$1,preco=$2,quantidade_estoque=$3,descricao=$4,status=$5,imagem=$6,categoria=$7 WHERE id=$8 RETURNING *',
      [nome, preco, quantidadeEstoque ?? 0, descricao ?? null, status ?? true, imagem ?? null, categoria ?? null, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Produto não encontrado' });
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro atualizar produto:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.delete('/produtos/:id', autenticar, async (req, res) => {
  try {
    const emUso = await pool.query('SELECT COUNT(*) as c FROM itens_pedidos WHERE id_produto=$1', [req.params.id]);
    if (parseInt(emUso.rows[0].c) > 0) return res.status(422).json({ error: 'Produto em uso em pedidos' });
    const r = await pool.query('DELETE FROM produtos WHERE id=$1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Produto não encontrado' });
    res.status(204).end();
  } catch (err) { console.error('Erro remover produto:', err); res.status(500).json({ error: 'Erro interno' }); }
});

/* ─────────────── AVALIAÇÕES ─────────────── */

app.get('/produtos/:id/avaliacoes', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT a.nota,a.comentario,a.data,u.nome FROM avaliacoes a JOIN usuarios u ON u.id=a.id_usuario WHERE a.id_produto=$1 ORDER BY a.data DESC',
      [req.params.id]);
    const media = await pool.query('SELECT AVG(nota)::numeric(3,2) as media, COUNT(*) as total FROM avaliacoes WHERE id_produto=$1', [req.params.id]);
    res.json({ avaliacoes: r.rows, media: Number(media.rows[0].media) || 0, total: parseInt(media.rows[0].total) });
  } catch (err) { console.error('Erro avaliacoes:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/produtos/:id/avaliar', autenticar, async (req, res) => {
  try {
    const { nota, comentario } = req.body;
    if (!nota || nota < 1 || nota > 5) return res.status(400).json({ error: 'Nota deve ser entre 1 e 5' });
    const existente = await pool.query('SELECT id FROM avaliacoes WHERE id_produto=$1 AND id_usuario=$2', [req.params.id, req.usuarioId]);
    if (existente.rows.length > 0) {
      await pool.query('UPDATE avaliacoes SET nota=$1,comentario=$2,data=NOW() WHERE id=$3', [nota, comentario ?? null, existente.rows[0].id]);
    } else {
      await pool.query('INSERT INTO avaliacoes (id_produto,id_usuario,nota,comentario) VALUES ($1,$2,$3,$4)', [req.params.id, req.usuarioId, nota, comentario ?? null]);
    }
    res.json({ ok: true });
  } catch (err) { console.error('Erro avaliar:', err); res.status(500).json({ error: 'Erro interno' }); }
});

/* ─────────────── PEDIDOS ─────────────── */

app.post('/pedidos', autenticar, async (req, res) => {
  try {
    const { idUsuario } = req.body;
    if (!idUsuario) return res.status(400).json({ error: 'idUsuario obrigatório' });
    if (idUsuario !== req.usuarioId) return res.status(403).json({ error: 'Usuário divergente do token' });
    const u = await pool.query('SELECT id FROM usuarios WHERE id=$1', [idUsuario]);
    if (u.rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado' });
    const r = await pool.query('INSERT INTO pedidos (id_usuario,total,status,data_pedido) VALUES ($1,0,$2,NOW()) RETURNING *', [idUsuario, 'ABERTO']);
    res.status(201).json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro criar pedido:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/pedidos', autenticar, async (req, res) => {
  try {
    const { status: filtoStatus } = req.query;
    let sql = 'SELECT p.*, COALESCE(json_agg(json_build_object(\'id\',i.id,\'id_produto\',i.id_produto,\'quantidade\',i.quantidade,\'preco_unitario\',i.preco_unitario,\'nome\',pr.nome,\'imagem\',pr.imagem) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),\'[]\') as itens FROM pedidos p LEFT JOIN itens_pedidos i ON i.id_pedido=p.id LEFT JOIN produtos pr ON pr.id=i.id_produto WHERE p.id_usuario=$1';
    const params = [req.usuarioId];
    if (filtoStatus) { params.push(filtoStatus); sql += ` AND p.status = $${params.length}`; }
    sql += ' GROUP BY p.id ORDER BY p.data_pedido DESC';
    const r = await pool.query(sql, params);
    res.json(r.rows.map(formatPreco));
  } catch (err) { console.error('Erro listar pedidos:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/pedidos/:id', autenticar, async (req, res) => {
  try {
    const r = await pool.query("SELECT p.*, COALESCE(json_agg(json_build_object('id',i.id,'id_produto',i.id_produto,'quantidade',i.quantidade,'preco_unitario',i.preco_unitario,'nome',pr.nome,'imagem',pr.imagem) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),'[]') as itens FROM pedidos p LEFT JOIN itens_pedidos i ON i.id_pedido=p.id LEFT JOIN produtos pr ON pr.id=i.id_produto WHERE p.id=$1 GROUP BY p.id", [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (r.rows[0].id_usuario !== req.usuarioId) return res.status(403).json({ error: 'Pedido de outro usuário' });
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro buscar pedido:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/pedidos/:id/finalizar', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = await client.query('SELECT * FROM pedidos WHERE id=$1 FOR UPDATE', [req.params.id]);
    if (p.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pedido não encontrado' }); }
    const pedido = p.rows[0];
    if (pedido.id_usuario !== req.usuarioId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Pedido de outro usuário' }); }
    if (pedido.status !== 'ABERTO') { await client.query('ROLLBACK'); return res.status(422).json({ error: `Pedido com status ${pedido.status}` }); }
    const ic = await client.query('SELECT COUNT(*) as c FROM itens_pedidos WHERE id_pedido=$1', [req.params.id]);
    if (parseInt(ic.rows[0].c) === 0) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Pedido vazio' }); }
    if (!pedido.endereco_entrega) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Defina o endereço de entrega antes de finalizar' }); }
    if (!pedido.metodo_pagamento) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Escolha um método de pagamento antes de finalizar' }); }
    const r = await client.query("UPDATE pedidos SET status='FINALIZADO' WHERE id=$1 RETURNING *", [req.params.id]);
    await client.query('COMMIT');
    res.json(formatPreco(r.rows[0]));
  } catch (err) { await client.query('ROLLBACK'); console.error('Erro finalizar:', err); res.status(500).json({ error: 'Erro interno' }); }
  finally { client.release(); }
});

app.post('/pedidos/:id/cancelar', autenticar, async (req, res) => {
  try {
    const p = await pool.query('SELECT * FROM pedidos WHERE id=$1', [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado' });
    const pedido = p.rows[0];
    if (pedido.id_usuario !== req.usuarioId) return res.status(403).json({ error: 'Pedido de outro usuário' });
    if (pedido.status !== 'ABERTO') return res.status(422).json({ error: `Não pode cancelar pedido ${pedido.status}` });
    const r = await pool.query("UPDATE pedidos SET status='CANCELADO' WHERE id=$1 RETURNING *", [req.params.id]);
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro cancelar:', err); res.status(500).json({ error: 'Erro interno' }); }
});

/* Marca um pedido finalizado como entregue (apresentação) */
app.post('/pedidos/:id/entregar', autenticar, async (req, res) => {
  try {
    const p = await pool.query('SELECT * FROM pedidos WHERE id=$1', [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado' });
    const pedido = p.rows[0];
    if (pedido.id_usuario !== req.usuarioId) return res.status(403).json({ error: 'Pedido de outro usuário' });
    if (pedido.status !== 'FINALIZADO') return res.status(422).json({ error: `Apenas pedidos FINALIZADO podem virar ENTREGUE (atual: ${pedido.status})` });
    const r = await pool.query("UPDATE pedidos SET status='ENTREGUE' WHERE id=$1 RETURNING *", [req.params.id]);
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro entregar:', err); res.status(500).json({ error: 'Erro interno' }); }
});

async function criarPedidosDemo(client, idUsuario, status, quantidade) {
  const prods = await client.query("SELECT id, nome, preco, imagem FROM produtos WHERE status = true ORDER BY RANDOM() LIMIT 5");
  if (prods.rows.length < 2) throw Object.assign(new Error('Cadastre pelo menos 2 produtos ativos'), { status: 400 });
  const criados = [];
  for (let i = 0; i < quantidade; i++) {
    const qtd = 1 + (i % 2);
    const escolhidos = prods.rows.slice(i % 2, (i % 2) + 2);
    const total = escolhidos.reduce((s, pp) => s + Number(pp.preco) * qtd, 0);
    const data = new Date(Date.now() - (i + 1) * 7 * 86400000);
    const pedido = await client.query(
      'INSERT INTO pedidos (id_usuario,total,status,data_pedido,endereco_entrega,metodo_pagamento) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [idUsuario, total, status, data, 'Rua das Flores, 123 - Centro, São Paulo - SP, CEP: 00000-000', ['PIX', 'Cartão', 'Boleto'][i]]
    );
    for (const pp of escolhidos) {
      await client.query(
        'INSERT INTO itens_pedidos (id_pedido,id_produto,quantidade,preco_unitario) VALUES ($1,$2,$3,$4)',
        [pedido.rows[0].id, pp.id, qtd, pp.preco]
      );
    }
    criados.push(formatPreco(pedido.rows[0]));
  }
  return criados;
}

/* Cria pedidos entregues de demonstração para o usuário logado (apresentação) */
app.post('/demo/pedidos-entregues', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criados = await criarPedidosDemo(client, req.usuarioId, 'ENTREGUE', 3);
    await client.query('COMMIT');
    res.status(201).json({ mensagem: '3 pedidos de demonstração entregues criados', pedidos: criados });
  } catch (err) { await client.query('ROLLBACK'); console.error('Erro demo entregues:', err); res.status(err.status ? 400 : 500).json({ error: err.message || 'Erro interno' }); }
  finally { client.release(); }
});

/* Cria pedidos FINALIZADO de demonstração (para marcar como entregue na apresentação) */
app.post('/demo/pedidos-finalizados', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const criados = await criarPedidosDemo(client, req.usuarioId, 'FINALIZADO', 2);
    await client.query('COMMIT');
    res.status(201).json({ mensagem: '2 pedidos finalizados de demonstração criados', pedidos: criados });
  } catch (err) { await client.query('ROLLBACK'); console.error('Erro demo finalizados:', err); res.status(err.status ? 400 : 500).json({ error: err.message || 'Erro interno' }); }
  finally { client.release(); }
});

/* ─────────────── CHECKOUT ─────────────── */

app.put('/pedidos/:id/checkout', autenticar, async (req, res) => {
  try {
    const { endereco_entrega, metodo_pagamento, observacoes } = req.body;
    if (!endereco_entrega || !endereco_entrega.trim()) {
      return res.status(400).json({ error: 'Endereço de entrega é obrigatório' });
    }
    const metodosValidos = ['PIX', 'Boleto', 'Dinheiro', 'Cartão'];
    if (!metodo_pagamento || !metodosValidos.includes(metodo_pagamento)) {
      return res.status(400).json({ error: 'Método de pagamento inválido. Use: PIX, Boleto, Dinheiro ou Cartão' });
    }

    const pedido = await pool.query('SELECT id_usuario, status FROM pedidos WHERE id=$1', [req.params.id]);
    if (pedido.rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (pedido.rows[0].id_usuario !== req.usuarioId) return res.status(403).json({ error: 'Pedido de outro usuário' });
    if (pedido.rows[0].status !== 'ABERTO') return res.status(422).json({ error: 'Pedido não está aberto' });

    const r = await pool.query(
      'UPDATE pedidos SET endereco_entrega=$1, metodo_pagamento=$2, observacoes=$3 WHERE id=$4 RETURNING *',
      [endereco_entrega.trim(), metodo_pagamento, observacoes || null, req.params.id]
    );
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro checkout:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/pedidos/:id/itens', autenticar, async (req, res) => {
  try {
    const p = await pool.query('SELECT id_usuario FROM pedidos WHERE id=$1', [req.params.id]);
    if (p.rows.length === 0) return res.status(404).json({ error: 'Pedido não encontrado' });
    if (p.rows[0].id_usuario !== req.usuarioId) return res.status(403).json({ error: 'Pedido de outro usuário' });
    const r = await pool.query('SELECT i.*,pr.nome,pr.imagem FROM itens_pedidos i JOIN produtos pr ON pr.id=i.id_produto WHERE i.id_pedido=$1 ORDER BY i.id', [req.params.id]);
    res.json(r.rows.map(formatPreco));
  } catch (err) { console.error('Erro itens:', err); res.status(500).json({ error: 'Erro interno' }); }
});

/* ─────────────── ITENS ─────────────── */

app.post('/itens', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    const { idPedido, idProduto, quantidade } = req.body;
    if (!idPedido || !idProduto || !quantidade) return res.status(400).json({ error: 'idPedido,idProduto,quantidade obrigatórios' });
    await client.query('BEGIN');
    const p = await client.query('SELECT id,id_usuario,status FROM pedidos WHERE id=$1 FOR UPDATE', [idPedido]);
    if (p.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Pedido não encontrado' }); }
    if (p.rows[0].id_usuario !== req.usuarioId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Pedido de outro usuário' }); }
    if (p.rows[0].status !== 'ABERTO') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Pedido não está aberto' }); }
    const prod = await client.query('SELECT * FROM produtos WHERE id=$1 FOR UPDATE', [idProduto]);
    if (prod.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Produto não encontrado' }); }
    if (prod.rows[0].quantidade_estoque < quantidade) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Estoque insuficiente' }); }
    await client.query('UPDATE produtos SET quantidade_estoque=quantidade_estoque-$1 WHERE id=$2', [quantidade, idProduto]);
    const item = await client.query('INSERT INTO itens_pedidos (id_pedido,id_produto,quantidade,preco_unitario) VALUES ($1,$2,$3,$4) RETURNING *', [idPedido, idProduto, quantidade, prod.rows[0].preco]);
    const total = await client.query('SELECT SUM(quantidade*preco_unitario) as t FROM itens_pedidos WHERE id_pedido=$1', [idPedido]);
    await client.query('UPDATE pedidos SET total=$1 WHERE id=$2', [total.rows[0].t, idPedido]);
    await client.query('COMMIT');
    res.status(201).json(formatPreco(item.rows[0]));
  } catch (err) { await client.query('ROLLBACK'); console.error('Erro add item:', err); res.status(500).json({ error: 'Erro interno' }); }
  finally { client.release(); }
});

app.put('/itens/:id', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    const { quantidade } = req.body;
    if (!quantidade || quantidade < 1) return res.status(400).json({ error: 'quantidade deve ser >= 1' });
    await client.query('BEGIN');
    const item = await client.query('SELECT i.*,p.id_usuario,p.status FROM itens_pedidos i JOIN pedidos p ON p.id=i.id_pedido WHERE i.id=$1 FOR UPDATE', [req.params.id]);
    if (item.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item não encontrado' }); }
    if (item.rows[0].id_usuario !== req.usuarioId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Pedido de outro usuário' }); }
    if (item.rows[0].status !== 'ABERTO') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Pedido não está aberto' }); }
    const diff = quantidade - item.rows[0].quantidade;
    if (diff > 0) {
      const prod = await client.query('SELECT quantidade_estoque FROM produtos WHERE id=$1 FOR UPDATE', [item.rows[0].id_produto]);
      if (prod.rows[0].quantidade_estoque < diff) { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Estoque insuficiente' }); }
      await client.query('UPDATE produtos SET quantidade_estoque=quantidade_estoque-$1 WHERE id=$2', [diff, item.rows[0].id_produto]);
    } else if (diff < 0) {
      await client.query('UPDATE produtos SET quantidade_estoque=quantidade_estoque+$1 WHERE id=$2', [Math.abs(diff), item.rows[0].id_produto]);
    }
    await client.query('UPDATE itens_pedidos SET quantidade=$1 WHERE id=$2', [quantidade, req.params.id]);
    const total = await client.query('SELECT SUM(quantidade*preco_unitario) as t FROM itens_pedidos WHERE id_pedido=$1', [item.rows[0].id_pedido]);
    await client.query('UPDATE pedidos SET total=$1 WHERE id=$2', [total.rows[0].t, item.rows[0].id_pedido]);
    await client.query('COMMIT');
    const updated = await pool.query('SELECT * FROM itens_pedidos WHERE id=$1', [req.params.id]);
    res.json(formatPreco(updated.rows[0]));
  } catch (err) { await client.query('ROLLBACK'); console.error('Erro upd item:', err); res.status(500).json({ error: 'Erro interno' }); }
  finally { client.release(); }
});

app.get('/itens/:id', autenticar, async (req, res) => {
  try {
    const r = await pool.query('SELECT i.*,p.id_usuario FROM itens_pedidos i JOIN pedidos p ON p.id=i.id_pedido WHERE i.id=$1', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Item não encontrado' });
    if (r.rows[0].id_usuario !== req.usuarioId) return res.status(403).json({ error: 'Pedido de outro usuário' });
    res.json(formatPreco(r.rows[0]));
  } catch (err) { console.error('Erro buscar item:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.delete('/itens/:id', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const item = await client.query('SELECT i.*,p.id_usuario,p.status FROM itens_pedidos i JOIN pedidos p ON p.id=i.id_pedido WHERE i.id=$1 FOR UPDATE', [req.params.id]);
    if (item.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Item não encontrado' }); }
    if (item.rows[0].id_usuario !== req.usuarioId) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'Pedido de outro usuário' }); }
    if (item.rows[0].status !== 'ABERTO') { await client.query('ROLLBACK'); return res.status(422).json({ error: 'Pedido não está aberto' }); }
    await client.query('UPDATE produtos SET quantidade_estoque=quantidade_estoque+$1 WHERE id=$2', [item.rows[0].quantidade, item.rows[0].id_produto]);
    await client.query('DELETE FROM itens_pedidos WHERE id=$1', [req.params.id]);
    const total = await client.query("SELECT COALESCE(SUM(quantidade*preco_unitario),0) as t FROM itens_pedidos WHERE id_pedido=$1", [item.rows[0].id_pedido]);
    await client.query('UPDATE pedidos SET total=$1 WHERE id=$2', [total.rows[0].t, item.rows[0].id_pedido]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) { await client.query('ROLLBACK'); console.error('Erro del item:', err); res.status(500).json({ error: 'Erro interno' }); }
  finally { client.release(); }
});

/* ─────────────── AI GENERATION ─────────────── */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.6-flash')
  .split(',').map(s => s.trim()).filter(Boolean);

async function geminiCall(parts, system) {
  if (!GEMINI_API_KEY) throw new Error('Chave GEMINI_API_KEY não configurada no .env');
  let ultimoErro = null;
  // Tenta cada modelo habilitado; em cota excedida (429) ou modelo
  // indisponível (404), parte para o próximo automaticamente.
  for (const modelo of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${GEMINI_API_KEY}`;
    const payload = {
      contents: [{ role: 'user', parts }],
      generationConfig: { temperature: 0.8 },
    };
    if (system) payload.systemInstruction = { parts: [{ text: system }] };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      ultimoErro = new Error('Falha ao chamar Gemini (' + modelo + '): ' + (e?.message || e));
      continue;
    }
    clearTimeout(timeout);

    if (response.status === 429) {
      ultimoErro = new Error('Gemini ' + modelo + ' sem cota (429)');
      continue;
    }
    if (!response.ok) {
      const txt = await response.text().catch(() => '');
      if (response.status === 404 || response.status === 400) {
        ultimoErro = new Error(`Gemini ${modelo} retornou ${response.status}: ${txt.slice(0, 120)}`);
        continue;
      }
      throw new Error(`Gemini retornou ${response.status}: ${txt.slice(0, 200)}`);
    }
    const data = await response.json();
    const text = (data.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '').join(' ').trim();
    if (!text) { ultimoErro = new Error('Gemini ' + modelo + ' não retornou texto'); continue; }
    return text;
  }
  throw new Error('Gemini sem disponibilidade: ' + (ultimoErro?.message || 'todos os modelos falharam'));
}

async function geminiDescreveFoto(dataUri, legenda) {
  const mime = dataUri.split(';')[0].replace('data:', '') || 'image/jpeg';
  const base64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
  const parts = [
    { text: 'Descreva em detalhes (português) a imagem a seguir. Identifique o personagem/animal/objeto PRINCIPAL e destaque tudo que o torna ÚNICO: espécie, cores exatas, formato, textura, acessórios, expressão e fundo. Esses detalhes serão usados para criar uma pelúcia personalizada e fofa, então foque nas características visuais marcantes. Seja objetivo e descritivo.' },
    { inline_data: { mime_type: mime, data: base64 } },
  ];
  if (legenda && legenda.trim()) {
    parts.push({ text: 'Observe também os pedidos adicionais do usuário: ' + legenda.trim() });
  }
  return geminiCall(parts, 'Você é um descritor de imagens para uma loja de pelúcias personalizadas. Você extrai as características mais marcantes e únicas de cada imagem.');
}

async function geminiCriaPrompt(conceito, legenda) {
  const texto = [
    'Com base na ideia abaixo, crie UM NOME fofo e curto de produto (2 a 5 palavras, título da pelúcia na loja) e UM ÚNICO prompt curto (máx. 80 palavras, em português) descrevendo UMA PELÚCIA FOFA que represente FIELMENTE essa ideia.',
    'FORMATO EXATO — responda APENAS com duas linhas:',
    'NOME: <nome do produto, ex: Ursinho Marrom do Lacinho Azul>',
    'PROMPT: <o prompt curto da pelúcia>',
    'REGRAS DO NOME:',
    '- Nome próprio fofo e único, sem repetir "pelúcia" nem "de pelúcia" (ex: "Raposa Laranja Fofinha", "Capivara da Tranquilidade").',
    '- Título de loja: começa com letra maiúscula e parece um nome dado à pelúcia.',
    'REGRAS DO PROMPT:',
    '- Preserve TODOS os detalhes específicos da ideia: espécie/animal, cores exatas, formato, acessórios e expressão, para que cada pelúcia seja ÚNICA e parecida com a referência.',
    '- NUNCA generalize para um ursinho genérico. Se a ideia tem algo específico (ex: raposa laranja, sereia roxa, capivara relaxando), a pelúcia DEVE ser desse algo específico.',
    '- A pelúcia é um brinquedo fofo e infantil: olhos grandes, bochechas, expressão adorável e abraçável.',
    '- PROIBIDO descrever humanos reais, pessoas, corpos, pele, roupas de humano, nudez ou sexualização.',
    '- Se a ideia for uma pessoa, vire-a em um animal de pelúcia fofo inspirado nela, mantendo as características marcantes (cabelo vira juba/orelhas, roupa vira laço etc).',
    '',
    'Ideia:',
    conceito,
  ];
  if (legenda && legenda.trim()) texto.push('Desejos do usuário: ' + legenda.trim());
  const resposta = await geminiCall([{ text: texto.join('\n') }],
    'Você é um especialista em criar prompts e nomes de pelúcias fofas para crianças. Você SEMPRE converte qualquer ideia em um brinquedo de pelúcia fofo, kawaii e infantil, mantendo a originalidade e os detalhes específicos da ideia. Você NUNCA descreve humanos, pessoas ou corpos. Responda no formato exato pedido: linha NOME: e linha PROMPT:.');

  let nome = '';
  let promptFinal = '';
  for (const linha of String(resposta).split('\n')) {
    const t = linha.trim();
    if (/^NOME:/i.test(t)) nome = t.replace(/^NOME:\s*/i, '').trim();
    else if (/^PROMPT:/i.test(t)) promptFinal = t.replace(/^PROMPT:\s*/i, '').trim();
    else if (!promptFinal && t) promptFinal = t;
  }
  if (!promptFinal) promptFinal = String(resposta).replace(/^NOME:.*/i, '').trim() || conceito;
  return { nome: nome || null, prompt: promptFinal };
}

const ESTILO_HOME_PADRAO =
  'Pelúcia kawaii fofa de loja: corpo redondo e abraçável, olhos grandes brilhantes e simpáticos, ' +
  'nariz e boca minúsculos, bochechas rosadas, costura e bordado bem detalhados, pelagem macia e fofa, ' +
  'cores suaves e vibrantes, sempre de frente com o rosto centralizado olhando para a câmera, ' +
  'foto de produto em estúdio com fundo limpo e iluminação suave.';

let _estiloHomeCache = null;
async function estiloReferenciaHome() {
  // Usa as pelúcias exibidas na home (banner + fotos dos produtos) como referência
  // de estilo para as pelúcias geradas. Calculado 1x e cacheado em disco.
  if (_estiloHomeCache) return _estiloHomeCache;
  const cachePath = path.join(__dirname, '..', 'dados', 'estilo-home.txt');
  try {
    if (fs.existsSync(cachePath)) {
      const t = fs.readFileSync(cachePath, 'utf8').trim();
      if (t) { _estiloHomeCache = t; return t; }
    }
  } catch (e) { /* segue o fluxo */ }

  try {
    const refs = [];
    // Referência principal: a pelúcia gerada "Cachorro verde" (estilo favorito do usuário)
    try {
      const r = await pool.query("SELECT imagem FROM produtos WHERE (categoria = 'Personalizada' OR nome ILIKE '%verde%') AND imagem LIKE '/uploads/geradas/%' ORDER BY id DESC LIMIT 1");
      if (r.rows.length && r.rows[0].imagem) {
        const f = path.join(__dirname, '..', 'dados', 'pelucias-geradas', path.basename(r.rows[0].imagem));
        if (fs.existsSync(f)) {
          refs.push({ mime: 'image/jpeg', data: fs.readFileSync(f).toString('base64') });
        }
      }
    } catch (e) { /* sem banco/imagem não é fatal */ }
    const dirProdutos = path.join(__dirname, '..', 'site', 'imagens', 'produtos');
    if (fs.existsSync(dirProdutos)) {
      const imgs = fs.readdirSync(dirProdutos)
        .filter(f => /\.(jpg|jpeg|png)$/i.test(f))
        .sort(() => Math.random() - 0.5).slice(0, 4);
      for (const f of imgs) {
        const buf = fs.readFileSync(path.join(dirProdutos, f));
        refs.push({ mime: /\.png$/i.test(f) ? 'image/png' : 'image/jpeg', data: buf.toString('base64') });
      }
    }
    const bannerPath = path.join(__dirname, '..', 'site', 'imagens', 'banner.png');
    if (fs.existsSync(bannerPath)) {
      refs.push({ mime: 'image/png', data: fs.readFileSync(bannerPath).toString('base64') });
    }
    if (refs.length) {
      const parts = [
        { text: 'Analise estas fotos de pelúcias da loja Fluffy Dreams. Descreva em até 60 palavras o ESTILO VISUAL dessas pelúcias: proporções, olhos, cara/expressão, acabamento e costura, cores, posição (de frente?), fundo e iluminação. Esse texto servirá de referência de estilo para gerar novas pelúcias fofas, detalhadas e sempre de frente. Em português, objetivo.' },
        ...refs.map(r => ({ inline_data: { mime_type: r.mime, data: r.data } })),
      ];
      const estilo = await geminiCall(parts,
        'Você é um diretor de arte especialista em pelúcias fofas e fotografia de produto.');
      if (estilo && estilo.trim()) {
        const t = estilo.trim().slice(0, 300);
        _estiloHomeCache = t;
        try {
          fs.mkdirSync(path.join(__dirname, '..', 'dados'), { recursive: true });
          fs.writeFileSync(cachePath, t);
        } catch (e) { /* cache em disco é opcional */ }
        return t;
      }
    }
  } catch (e) {
    console.error('Falha ao extrair estilo da home:', e?.message || e);
  }
  _estiloHomeCache = ESTILO_HOME_PADRAO;
  return ESTILO_HOME_PADRAO;
}

async function geraImagemPollinations(prompt) {
  // A aparência da pelúcia é guiada PELO PROMPT GERADO PELO GEMINI (específico).
  // Aqui garantimos que é uma pelúcia (sem humanos) fofa e detalhada, sempre de
  // frente, usando as pelúcias da home como referência de estilo. A instrução
  // "NÃO é humano" fica no INÍCIO do prompt (o flux dá mais peso ao começo) e
  // ainda fazemos verificação visual com o Gemini: se aparecer humano, regenera.
  const conceito = (prompt || '').trim();
  const vibes = [
    'kawaii chibi style',
    'squishy and huggable style',
    'fluffy and adorable style',
    'round and cuddly style',
    'pastel soft kawaii style',
  ];
  const vibe = vibes[Math.floor(Math.random() * vibes.length)];
  const estiloRef = await estiloReferenciaHome();
  const naoHumano = 'PLUSH STUFFED TOY ONLY - THIS IS A CHILDREN\'S PLUSH TOY, NOT A HUMAN, NOT A REAL PERSON, NOT A PHOTO OF A PERSON. No humans, no people, no woman, no man, no person, no human face, no skin, no body, no nude.';
  const guard = `${naoHumano} super cute soft plush stuffed toy, ${vibe}, fluffy plush fabric, children's plush toy, studio product photo, high quality. FRONT VIEW, FORWARD FACING: the plushie faces the camera directly, looking straight ahead, full adorable plush face clearly visible, big shiny kawaii button eyes looking forward, centered composition, never from behind, never sideways, never back view. HIGHLY DETAILED and polished: intricate embroidery, soft rich fur texture, cute stitched details, premium handcrafted children's toy. STRICTLY a plush toy made of fabric and stuffing: no real humans, no people, no body, no skin, no nude. Style reference from the store's plushies: ${estiloRef}`;
  const finalPrompt = conceito
    ? `${naoHumano} ${conceito}. ${guard}`
    : `cute teddy bear plush toy. ${guard}`;
  const negative = 'human,woman,man,person,people,baby,face,skin,body,portrait,nude';

  let ultimoErro = null;
  for (let tentativa = 0; tentativa < 4; tentativa++) {
    const seed = Math.floor(Math.random() * 100000);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?model=flux&width=1024&height=1024&seed=${seed}&safe=true&negative=${encodeURIComponent(negative)}`;

    // A Pollinations às vezes responde 503/5xx de forma transitória:
    // tenta até 3 vezes com espera crescente antes de desistir.
    let response = null;
    let ultimoStatus = null;
    for (let httpTry = 0; httpTry < 3; httpTry++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      try {
        response = await fetch(url, { signal: controller.signal });
      } catch (e) {
        clearTimeout(timeout);
        ultimoStatus = 'network: ' + (e?.message || e);
        if (httpTry < 2) { await new Promise(r => setTimeout(r, 2000 * (httpTry + 1))); continue; }
        break;
      }
      clearTimeout(timeout);
      if (response.ok) break;
      ultimoStatus = response.status;
      if (httpTry < 2) { await new Promise(r => setTimeout(r, 2000 * (httpTry + 1))); }
    }

    if (!response || !response.ok) { ultimoErro = `API de imagem retornou ${ultimoStatus} após tentativas`; continue; }

    const buffer = Buffer.from(await response.arrayBuffer());
    const resultado = {
      url: `data:image/jpeg;base64,${buffer.toString('base64')}`,
      tamanho: buffer.length,
      buffer,
    };

    // Verificação visual: a imagem tem que ser UMA PELÚCIA (sem humanos).
    if (await geminiVerificaPelucia(resultado.url)) return resultado;

    ultimoErro = 'Imagem gerada não era uma pelúcia (continha humano/pessoa)';
    console.warn('Regenerando imagem (tinha humano) — tentativa ' + (tentativa + 1));
    await new Promise(r => setTimeout(r, 1500));
  }
  throw new Error(ultimoErro || 'Não foi possível gerar uma imagem de pelúcia');
}

// Verifica com o Gemini (visão) se a imagem gerada é exclusivamente uma pelúcia.
// Se a API de visão estiver indisponível/cota zerada, assume que está ok para
// não bloquear a geração (retorna true).
async function geminiVerificaPelucia(dataUri) {
  try {
    const base64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
    const parts = [
      { text: 'Responda APENAS com SIM ou NÃO. Esta imagem mostra exclusivamente um bicho de pelúcia / brinquedo de pano (plush toy, stuffed animal)? Se aparecer QUALQUER pessoa, humano, rosto humano real, mão, pele ou corpo de gente, responda NÃO.' },
      { inline_data: { mime_type: 'image/jpeg', data: base64 } },
    ];
    const r = await geminiCall(parts, 'Você é um moderador de conteúdo. Responda apenas SIM ou NÃO.');
    return /^sim|^s$/i.test((r || '').trim());
  } catch (e) {
    console.error('Verificação de pelúcia indisponível (segue sem verificar):', e?.message || e);
    return true;
  }
}

function nomeDePrompt(texto) {
  let n = (texto || '').replace(/\s+/g, ' ').trim();
  if (n.length > 60) n = n.slice(0, 60).replace(/\s+\S*$/, '');
  return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Pelúcia Personalizada';
}

function formatBRL(v) {
  return 'R$' + Number(v).toFixed(2).replace('.', ',');
}

// Sorteia o "preço secreto" da loja para cada pelúcia gerada (R$ 80 a R$ 200).
// É determinístico por idGeracao: a mesma pelúcia mantém o mesmo alvo entre tentativas.
function alvoNegociacao(idGeracao) {
  let h = 0;
  for (let i = 0; i < idGeracao.length; i++) {
    h = (h * 31 + idGeracao.charCodeAt(i)) | 0;
  }
  return 80 + (Math.abs(h) % 121);
}

app.post('/generate', async (req, res) => {
  try {
    const { modo, prompt, imagem, legenda } = req.body;

    let descricaoFoto = null;
    let promptFinal;
    let nomeSugerido;

    if (modo === 'imagem' || imagem) {
      if (!imagem) return res.status(400).json({ error: 'Envie uma imagem para o fluxo personalizado' });

      // Etapa 1 — Visão (Gemini): descreve a foto enviada
      descricaoFoto = await geminiDescreveFoto(imagem, legenda);

      // Etapa 2 — Texto (Gemini): transforma a descrição em prompt e nome de pelúcia
      const ger2 = await geminiCriaPrompt(descricaoFoto, legenda);
      promptFinal = ger2.prompt;
      nomeSugerido = ger2.nome || nomeDePrompt(legenda || descricaoFoto);
    } else {
      // Fluxo por texto: o Gemini converte a ideia do usuário em prompt de pelúcia
      // (sanitiza qualquer conceito, garantindo sempre um brinquedo fofo infantil)
      if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Digite uma descrição para sua pelúcia' });
      const ger = await geminiCriaPrompt(prompt.trim());
      promptFinal = ger.prompt;
      nomeSugerido = ger.nome || nomeDePrompt(prompt);
    }

    // Etapa 3 — Imagem (Pollinations): gera a pelúcia
    const imagemResult = await geraImagemPollinations(promptFinal);

    // Salva a imagem em disco para poder ir ao carrinho se a negociação for aceita
    const idGeracao = crypto.randomUUID();
    const dirGeradas = path.join(__dirname, '..', 'dados', 'pelucias-geradas');
    fs.mkdirSync(dirGeradas, { recursive: true });
    fs.writeFileSync(path.join(dirGeradas, `${idGeracao}.jpg`), imagemResult.buffer);

    res.json({
      url: imagemResult.url,
      tamanho: imagemResult.tamanho,
      descricao: descricaoFoto,
      prompt: promptFinal,
      idGeracao,
      nomeSugerido,
    });
  } catch (error) {
    console.error('Erro generate:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Erro ao gerar imagem' });
  }
});

/* Negociação de valor da pelúcia gerada:
   a loja sorteia um preço secreto entre R$ 80 e R$ 200.
   Proposta >= alvo → aceita e vai pro carrinho.
   Proposta < alvo  → recusada, pede para subir o valor. */
app.post('/generate/negociar', autenticar, async (req, res) => {
  const client = await pool.connect();
  try {
    const { idGeracao, valor, nome, pedidoId } = req.body;
    if (!idGeracao) return res.status(400).json({ error: 'idGeracao obrigatório' });
    const v = Number(valor);
    if (!v || v <= 0) return res.status(400).json({ error: 'Informe um valor válido' });

    const arquivo = path.join(__dirname, '..', 'dados', 'pelucias-geradas', `${idGeracao}.jpg`);
    if (!fs.existsSync(arquivo)) return res.status(404).json({ error: 'Imagem gerada não encontrada. Gere novamente.' });

    const alvo = alvoNegociacao(idGeracao);
    if (v < alvo) {
      return res.json({
        aprovado: false,
        mensagem: `A lojinha recusou sua proposta de ${formatBRL(v)}. Ela está pedindo mais... tente negociar com um valor mais alto! 💔`,
      });
    }

    await client.query('BEGIN');

    // 1) Cria o produto da pelúcia personalizada com o valor aceito
    const imagemUrl = `/uploads/geradas/${idGeracao}.jpg`;
    const nomeProduto = (nome && nome.trim()) ? nome.trim().slice(0, 150) : 'Pelúcia Personalizada';
    const prod = await client.query(
      'INSERT INTO produtos (nome,preco,quantidade_estoque,descricao,status,imagem,categoria) VALUES ($1,$2,1,$3,true,$4,$5) RETURNING *',
      [nomeProduto, v, 'Pelúcia exclusiva criada por IA na Fluffy Dreams', imagemUrl, 'Personalizada']
    );

    // 2) Adiciona ao carrinho (pedido ABERTO do usuário, criando se preciso)
    let idPedido = Number(pedidoId) || null;
    if (idPedido) {
      const p = await client.query('SELECT id,id_usuario,status FROM pedidos WHERE id=$1 FOR UPDATE', [idPedido]);
      if (p.rows.length === 0 || p.rows[0].id_usuario !== req.usuarioId || p.rows[0].status !== 'ABERTO') idPedido = null;
    }
    if (!idPedido) {
      const aberto = await client.query("SELECT id FROM pedidos WHERE id_usuario=$1 AND status='ABERTO' ORDER BY data_pedido DESC LIMIT 1", [req.usuarioId]);
      idPedido = aberto.rows.length ? aberto.rows[0].id : null;
      if (!idPedido) {
        const novo = await client.query('INSERT INTO pedidos (id_usuario,total,status,data_pedido) VALUES ($1,0,$2,NOW()) RETURNING id', [req.usuarioId, 'ABERTO']);
        idPedido = novo.rows[0].id;
      }
    }

    await client.query('INSERT INTO itens_pedidos (id_pedido,id_produto,quantidade,preco_unitario) VALUES ($1,$2,1,$3)', [idPedido, prod.rows[0].id, v]);
    const total = await client.query('SELECT COALESCE(SUM(quantidade*preco_unitario),0) as t FROM itens_pedidos WHERE id_pedido=$1', [idPedido]);
    await client.query('UPDATE pedidos SET total=$1 WHERE id=$2', [total.rows[0].t, idPedido]);

    await client.query('COMMIT');
    res.json({
      aprovado: true,
      mensagem: `Proposta aceita! Sua pelúcia foi adicionada ao carrinho por ${formatBRL(v)} 🎉`,
      pedidoId: idPedido,
      produtoId: prod.rows[0].id,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro negociar:', err?.message || err);
    res.status(500).json({ error: err?.message || 'Erro interno' });
  } finally {
    client.release();
  }
});

/* ─────────────── ADMIN ─────────────── */

app.get('/admin/pedidos', autenticar, async (req, res) => {
  try {
    const { status: s } = req.query;
    let sql = "SELECT p.*, u.nome as usuario_nome, COALESCE(json_agg(json_build_object('id',i.id,'id_produto',i.id_produto,'quantidade',i.quantidade,'preco_unitario',i.preco_unitario,'nome',pr.nome) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),'[]') as itens FROM pedidos p JOIN usuarios u ON u.id=p.id_usuario LEFT JOIN itens_pedidos i ON i.id_pedido=p.id LEFT JOIN produtos pr ON pr.id=i.id_produto";
    const params = [];
    if (s) { params.push(s); sql += ` WHERE p.status = $${params.length}`; }
    sql += ' GROUP BY p.id, u.nome ORDER BY p.data_pedido DESC';
    const r = await pool.query(sql, params);
    res.json(r.rows.map(formatPreco));
  } catch (err) { console.error('Erro admin pedidos:', err); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/admin/usuarios', autenticar, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,nome,email,data_cadastro FROM usuarios ORDER BY id');
    res.json(r.rows);
  } catch (err) { console.error('Erro admin usuarios:', err); res.status(500).json({ error: 'Erro interno' }); }
});

/* ─────────────── START ─────────────── */

app.listen(PORT, () => {
  console.log(`Fluffy Dreams rodando em http://localhost:${PORT}`);
});
