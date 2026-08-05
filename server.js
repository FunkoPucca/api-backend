require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');
const { autenticar } = require('./middleware');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const JWT_EXPIRATION_MS = parseInt(process.env.JWT_EXPIRATION_MS || '3600000');

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

async function geminiCall(parts, system) {
  if (!GEMINI_API_KEY) throw new Error('Chave GEMINI_API_KEY não configurada no .env');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.8 }
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
    throw new Error('Falha ao chamar Gemini: ' + (e?.message || e));
  }
  clearTimeout(timeout);

  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`Gemini retornou ${response.status}: ${txt.slice(0, 200)}`);
  }
  const data = await response.json();
  const text = (data.candidates?.[0]?.content?.parts || [])
    .map(p => p.text || '').join(' ').trim();
  if (!text) throw new Error('Gemini não retornou texto');
  return text;
}

async function geminiDescreveFoto(dataUri, legenda) {
  const mime = dataUri.split(';')[0].replace('data:', '') || 'image/jpeg';
  const base64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
  const parts = [
    { text: 'Descreva em detalhes (português) a imagem a seguir: cores, objeto, formato, expressão, fundo e qualquer detalhe que dê para transformar em uma pelúcia. Seja objetivo e descritivo.' },
    { inline_data: { mime_type: mime, data: base64 } },
  ];
  if (legenda && legenda.trim()) {
    parts.push({ text: 'Observe também os pedidos adicionais do usuário: ' + legenda.trim() });
  }
  return geminiCall(parts, 'Você é um descritor de imagens para uma loja de pelúcias personalizadas.');
}

async function geminiCriaPrompt(descricaoFoto, legenda) {
  const texto = [
    'Com base na descrição da foto de referência, crie UM ÚNICO prompt curto (máx. 60 palavras, em português)',
    'descrevendo uma pelúcia fofa que represente essa referência. Inclua: animal/forma, cor, acessórios e expressão.',
    'Não escreva nada além do prompt.',
    '',
    'Descrição da foto:',
    descricaoFoto,
  ];
  if (legenda && legenda.trim()) texto.push('Desejos do usuário: ' + legenda.trim());
  return geminiCall([{ text: texto.join('\n') }], 'Você é um especialista em criar prompts de pelúcias fofas.');
}

async function geraImagemPollinations(prompt) {
  const baseStyle = 'ultra cute teddy bear plush toy, soft fluffy fur, adorable big shiny eyes, small rounded ears, chubby round body, warm cozy atmosphere, high quality, detailed texture, studio lighting';
  const finalPrompt = prompt ? `${prompt}, ${baseStyle}` : baseStyle;
  const seed = Math.floor(Math.random() * 100000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(finalPrompt)}?model=flux&width=1024&height=1024&seed=${seed}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (e) {
    clearTimeout(timeout);
    throw new Error('Falha ao gerar imagem: ' + (e?.message || e));
  }
  clearTimeout(timeout);

  if (!response.ok) throw new Error(`API de imagem retornou ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    url: `data:image/jpeg;base64,${buffer.toString('base64')}`,
    tamanho: buffer.length,
  };
}

app.post('/generate', async (req, res) => {
  try {
    const { modo, prompt, imagem, legenda } = req.body;

    if (modo === 'imagem' || imagem) {
      if (!imagem) return res.status(400).json({ error: 'Envie uma imagem para o fluxo personalizado' });

      // Etapa 1 — Visão (Gemini): descreve a foto enviada
      const descricaoFoto = await geminiDescreveFoto(imagem, legenda);

      // Etapa 2 — Texto (Gemini): transforma a descrição em prompt de pelúcia
      const promptFinal = await geminiCriaPrompt(descricaoFoto, legenda);

      // Etapa 3 — Imagem (Pollinations): gera o ursinho
      const imagemResult = await geraImagemPollinations(promptFinal);

      return res.json({
        url: imagemResult.url,
        tamanho: imagemResult.tamanho,
        descricao: descricaoFoto,
        prompt: promptFinal,
      });
    }

    // Fluxo por texto: usa a descrição do usuário direto na geração
    if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Digite uma descrição para sua pelúcia' });
    const promptFinal = prompt.trim();
    const imagemResult = await geraImagemPollinations(promptFinal);
    res.json({ url: imagemResult.url, tamanho: imagemResult.tamanho, prompt: promptFinal });
  } catch (error) {
    console.error('Erro generate:', error?.message || error);
    res.status(500).json({ error: error?.message || 'Erro ao gerar imagem' });
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
