(function () {
  'use strict';

  const API = (window.SITE_CONFIG && window.SITE_CONFIG.API_URL) || '';

  /* ─────────── Auth ─────────── */
  function getToken() { return localStorage.getItem('fluffy_token'); }
  function setToken(t) { localStorage.setItem('fluffy_token', t); }
  function clearToken() { localStorage.removeItem('fluffy_token'); }
  function isLoggedIn() { return !!getToken(); }

  function getUser() {
    try { return JSON.parse(localStorage.getItem('fluffy_user')); } catch { return null; }
  }
  function setUser(u) { localStorage.setItem('fluffy_user', JSON.stringify(u)); }
  function clearUser() { localStorage.removeItem('fluffy_user'); }

  async function apiFetch(path, opts) {
    opts = opts || {};
    const headers = { 'Content-Type': 'application/json' };
    const t = getToken();
    if (t) headers['Authorization'] = 'Bearer ' + t;
    if (opts.headers) Object.assign(headers, opts.headers);
    if (opts.body && typeof opts.body === 'object') opts.body = JSON.stringify(opts.body);
    const res = await fetch(API + path, { ...opts, headers });
    if (res.status === 204) return null;
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Erro na requisição');
    return data;
  }

  /* ─────────── Cart (API) ─────────── */
  let currentOrderId = null;
  let orderIdPromise = null;

  async function ensureOrder() {
    const user = getUser();
    if (!user) return null;
    const stored = localStorage.getItem('fluffy_order_id');
    if (stored) { currentOrderId = parseInt(stored); return currentOrderId; }
    if (orderIdPromise) return orderIdPromise;
    orderIdPromise = (async () => {
      try {
        const order = await apiFetch('/pedidos', { method: 'POST', body: { idUsuario: user.id } });
        currentOrderId = order.id;
        localStorage.setItem('fluffy_order_id', String(order.id));
        return currentOrderId;
      } catch (e) { console.error('Erro criar pedido:', e); return null; }
    })();
    return orderIdPromise;
  }

  async function getCartItems() {
    if (!currentOrderId && !(await ensureOrder())) return [];
    try { return await apiFetch('/pedidos/' + currentOrderId + '/itens'); } catch { return []; }
  }

  async function addToCart(produtoId, qtd) {
    if (!(await ensureOrder())) { showToast('Faça login para adicionar ao carrinho'); return; }
    await apiFetch('/itens', { method: 'POST', body: { idPedido: currentOrderId, idProduto: produtoId, quantidade: qtd || 1 } });
    await updateBadges();
  }

  async function updateItemQty(itemId, qtd) {
    await apiFetch('/itens/' + itemId, { method: 'PUT', body: { quantidade: Math.max(1, qtd) } });
  }

  async function removeItem(itemId) {
    await apiFetch('/itens/' + itemId, { method: 'DELETE' });
  }

  async function finalizeOrder() {
    if (!currentOrderId) return;
    await apiFetch('/pedidos/' + currentOrderId + '/finalizar', { method: 'POST' });
    localStorage.removeItem('fluffy_order_id');
    currentOrderId = null; orderIdPromise = null;
  }

  async function updateBadges() {
    const els = document.querySelectorAll('.cart-badge');
    if (!isLoggedIn()) { els.forEach(b => { b.textContent = '0'; b.style.display = 'none'; }); return; }
    try {
      const items = await getCartItems();
      const count = items.reduce((s, i) => s + i.quantidade, 0);
      els.forEach(b => { b.textContent = count; b.style.display = count > 0 ? 'flex' : 'none'; });
    } catch { els.forEach(b => { b.textContent = '0'; b.style.display = 'none'; }); }
  }

  /* ─────────── Toast ─────────── */
  let toastTimer = null;
  function showToast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
  }

  /* ─────────── Helpers ─────────── */
  function formatPrice(v) { return 'R$ ' + Number(v).toFixed(2).replace('.', ','); }

  const ICONS = {
    cart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="20" r="1.4" fill="currentColor" stroke="none"/><circle cx="17" cy="20" r="1.4" fill="currentColor" stroke="none"/><path d="M2.5 3h2l2.2 11.6a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 2-1.6L20 7H5.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/></svg>',
  };

  function statusBadge(s) {
    const colors = { ABERTO: '#f59e0b', FINALIZADO: '#10b981', CANCELADO: '#ef4444' };
    return '<span class="status-badge" style="background:' + (colors[s] || '#999') + '">' + s + '</span>';
  }

  /* ─────────── Card ─────────── */
  function createCard(p) {
    const card = document.createElement('a');
    card.className = 'card';
    card.href = 'produto.html?id=' + p.id;
    card.innerHTML =
      '<div class="card-media">' +
      '<img src="' + (p.imagem || '') + '" alt="' + p.nome + '" loading="lazy" onerror="this.closest(\'.card-media\').innerHTML=\'<div class=img-placeholder><svg width=48 height=48 viewBox=\\"0 0 24 24\\" fill=none stroke=#ccc stroke-width=1.5><rect x=3 y=3 width=18 height=18 rx=2/><circle cx=8.5 cy=8.5 r=1.5 fill=#ccc/><path d=\\"M3 16l5-5 4 4 3-3 6 6\\"/></svg></div>\'" />' +
      (p.categoria ? '<span class="card-cat">' + p.categoria + '</span>' : '') +
      '</div>' +
      '<div class="card-title">' + p.nome + '</div>' +
      '<div class="card-footer"><div class="card-price">' + formatPrice(p.preco) + '</div>' +
      '<button class="cart-btn" type="button">' + ICONS.cart + ' CARRINHO</button></div>';
    card.querySelector('.cart-btn').addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      addToCart(p.id, 1).then(() => showToast(p.nome + ' adicionado!')).catch(e => showToast(e.message));
    });
    return card;
  }

  /* ─────────── Banner ─────────── */
  function renderBanner() {
    const b = document.querySelector('.banner'); if (!b) return;
    const cfg = window.SITE_CONFIG.banner || {};
    const img = b.querySelector('#banner-img');
    if (img && cfg.image) { img.src = cfg.image; img.alt = cfg.alt || ''; }
    if (!b.querySelector('.banner-content') && cfg.title) {
      const c = document.createElement('div'); c.className = 'banner-content';
      c.innerHTML = '<h1>' + cfg.title + '</h1><p>' + (cfg.subtitle || '') + '</p><a class="btn-primary" href="' + (cfg.href || '#') + '">' + (cfg.cta || 'Comprar') + '</a>';
      b.appendChild(c);
    }
  }

  /* ─────────── Catalog ─────────── */
  async function renderCatalog() {
    const m = document.getElementById('catalog'); if (!m) return;
    m.innerHTML = '<section class="catalog" id="catalogo">' +
      '<h2 class="section-title">Nossas pelúcias</h2>' +
      '<div class="filter-bar" id="filter-bar"><button class="filter-btn active" data-cat="">Todas</button></div>' +
      '<div class="product-grid" id="product-grid"><div class="loading-spinner"></div></div></section>';

    // Load categories
    try {
      const cats = await apiFetch('/categorias');
      const fb = document.getElementById('filter-bar');
      cats.forEach(c => {
        const btn = document.createElement('button');
        btn.className = 'filter-btn'; btn.dataset.cat = c;
        btn.textContent = c;
        btn.addEventListener('click', () => loadProducts(c, btn));
        fb.appendChild(btn);
      });
    } catch {}

    async function loadProducts(cat, activeBtn) {
      const grid = document.getElementById('product-grid');
      grid.innerHTML = '<div class="loading-spinner"></div>';
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      if (activeBtn) activeBtn.classList.add('active');
      try {
        const params = cat ? '?categoria=' + encodeURIComponent(cat) : '';
        let produtos = await apiFetch('/produtos' + params);
        produtos = produtos.filter(p => p.status !== false);
        grid.innerHTML = '';
        if (produtos.length === 0) { grid.innerHTML = '<p class="empty-state">Nenhum produto encontrado.</p>'; return; }
        produtos.forEach(p => grid.appendChild(createCard(p)));
      } catch { grid.innerHTML = '<p class="empty-state">Erro ao carregar produtos.</p>'; }
    }

    loadProducts('', document.querySelector('.filter-btn'));
  }

  /* ─────────── Product Page ─────────── */
  function getQueryId() { return new URLSearchParams(window.location.search).get('id'); }

  async function renderProductPage() {
    const c = document.getElementById('product-page-content'); if (!c) return;
    const id = getQueryId();
    if (!id) { c.innerHTML = '<div class="empty-state"><h2>Produto não encontrado</h2><a class="btn-primary" href="index.html">Voltar</a></div>'; return; }

    try {
      c.innerHTML = '<div class="loading-spinner"></div>';
      const p = await apiFetch('/produtos/' + id);
      document.title = p.nome + ' - Fluffy Dreams';
      let qty = 1;

      // Load reviews
      let reviewsHtml = '';
      try {
        const rev = await apiFetch('/produtos/' + id + '/avaliacoes');
        if (rev.avaliacoes && rev.avaliacoes.length > 0) {
          const stars = ICONS.star.repeat(Math.round(rev.media));
          reviewsHtml = '<div class="reviews-section"><h3>Avaliações <span class="review-summary">' + stars + ' ' + rev.media.toFixed(1) + ' (' + rev.total + ')</span></h3>';
          rev.avaliacoes.forEach(a => {
            const s = ICONS.star.repeat(a.nota);
            reviewsHtml += '<div class="review-item"><div class="review-stars">' + s + '</div><strong>' + a.nome + '</strong><p>' + (a.comentario || '') + '</p></div>';
          });
          reviewsHtml += '</div>';
        }
      } catch {}

      // Review form (if logged in)
      const reviewForm = isLoggedIn() ?
        '<div class="review-form"><h4>Avalie este produto</h4><div class="star-select" id="star-select">' +
        [1,2,3,4,5].map(n => '<button class="star-btn" data-v="' + n + '">' + ICONS.star + '</button>').join('') +
        '</div><textarea id="review-comment" placeholder="Comentário (opcional)" rows="2"></textarea>' +
        '<button class="btn-primary btn-sm" id="review-submit">Enviar avaliação</button></div>' : '';

      c.innerHTML =
        '<div class="product-detail">' +
        '<div class="product-gallery"><img src="' + (p.imagem || '') + '" alt="' + p.nome + '" onerror="this.closest(\'.product-gallery\').innerHTML=\'<div class=img-placeholder><svg width=64 height=64 viewBox=\\"0 0 24 24\\" fill=none stroke=#ccc stroke-width=1.5><rect x=3 y=3 width=18 height=18 rx=2/><circle cx=8.5 cy=8.5 r=1.5 fill=#ccc/><path d=\\"M3 16l5-5 4 4 3-3 6 6\\"/></svg></div>\'" /></div>' +
        '<div class="product-info">' +
        (p.categoria ? '<span class="product-tag">' + p.categoria + '</span>' : '') +
        '<h1>' + p.nome + '</h1>' +
        '<div class="price">' + formatPrice(p.preco) + '</div>' +
        '<div class="stock-info">' + (p.quantidade_estoque > 0 ? '<span class="in-stock">Em estoque (' + p.quantidade_estoque + ' unid.)</span>' : '<span class="out-of-stock">Fora de estoque</span>') + '</div>' +
        '<p>' + (p.descricao || '') + '</p>' +
        '<div class="qty-row"><div class="qty-control">' +
        '<button type="button" data-act="dec">−</button><span id="qty-value">1</span><button type="button" data-act="inc">+</button>' +
        '</div></div>' +
        '<button class="btn-primary" id="add-to-cart" ' + (p.quantidade_estoque <= 0 ? 'disabled' : '') + '>Adicionar ao carrinho</button>' +
        '</div></div>' +
        reviewsHtml + reviewForm;

      // Qty controls
      const qtyEl = c.querySelector('#qty-value');
      c.querySelectorAll('.qty-control button').forEach(btn => {
        btn.addEventListener('click', () => {
          qty = btn.dataset.act === 'inc' ? qty + 1 : Math.max(1, qty - 1);
          qtyEl.textContent = qty;
        });
      });

      // Add to cart
      c.querySelector('#add-to-cart').addEventListener('click', () => {
        addToCart(p.id, qty).then(() => showToast(p.nome + ' (' + qty + ') adicionado!')).catch(e => showToast(e.message));
      });

      // Star rating
      let selectedNota = 0;
      const starBtns = c.querySelectorAll('.star-btn');
      starBtns.forEach(btn => {
        btn.addEventListener('click', () => {
          selectedNota = parseInt(btn.dataset.v);
          starBtns.forEach((b, i) => b.style.color = i < selectedNota ? '#f59e0b' : '#ccc');
        });
      });

      // Submit review
      const reviewBtn = c.querySelector('#review-submit');
      if (reviewBtn) {
        reviewBtn.addEventListener('click', async () => {
          if (!selectedNota) { showToast('Selecione uma nota'); return; }
          try {
            await apiFetch('/produtos/' + id + '/avaliar', {
              method: 'POST', body: { nota: selectedNota, comentario: document.getElementById('review-comment').value }
            });
            showToast('Avaliação enviada!');
            renderProductPage(); // reload
          } catch (e) { showToast(e.message); }
        });
      }

      renderRecommended(id);
    } catch {
      c.innerHTML = '<div class="empty-state"><h2>Produto não encontrado</h2><a class="btn-primary" href="index.html">Voltar</a></div>';
    }
  }

  async function renderRecommended(excludeId) {
    const c = document.getElementById('recommended'); if (!c) return;
    try {
      const produtos = await apiFetch('/produtos');
      const others = produtos.filter(p => p.status !== false && p.id !== excludeId).slice(0, 4);
      if (others.length === 0) return;
      c.innerHTML = '<section class="recommended"><h2 class="section-title">Recomendados pra você</h2><div class="card-row" id="rec-row"></div></section>';
      const row = c.querySelector('#rec-row');
      others.forEach(p => row.appendChild(createCard(p)));
    } catch {}
  }

  /* ─────────── Cart Page + Checkout ─────────── */
  async function renderCartPage() {
    const c = document.getElementById('cart-page-content'); if (!c) return;
    if (!isLoggedIn()) {
      c.innerHTML = '<div class="empty-state"><h2>Faça login para ver seu carrinho</h2><a class="btn-primary" href="login.html">Entrar</a></div>';
      return;
    }
    async function draw() {
      if (!currentOrderId && !(await ensureOrder())) {
        c.innerHTML = '<div class="empty-state"><h2>Seu carrinho está vazio</h2><p>Que tal escolher uma pelúcia?</p><a class="btn-primary" href="index.html">Ver produtos</a></div>';
        return;
      }
      let cart;
      try { cart = await getCartItems(); } catch { cart = []; }
      if (!cart || cart.length === 0) {
        c.innerHTML = '<div class="empty-state"><h2>Seu carrinho está vazio</h2><p>Que tal escolher uma pelúcia?</p><a class="btn-primary" href="index.html">Ver produtos</a></div>';
        return;
      }
      const enriched = await Promise.all(cart.map(async (item) => {
        try { const p = await apiFetch('/produtos/' + item.id_produto); return { ...item, nome: p.nome, preco: item.preco_unitario, imagem: p.imagem }; }
        catch { return { ...item, nome: 'Produto #' + item.id_produto, preco: item.preco_unitario, imagem: null }; }
      }));
      const rows = enriched.map(item =>
        '<div class="cart-item" data-id="' + item.id + '">' +
        '<img src="' + (item.imagem || '') + '" alt="' + item.nome + '" onerror="this.style.display=\'none\'" />' +
        '<div class="ci-info"><div class="ci-name">' + item.nome + '</div><div class="ci-price">' + formatPrice(item.preco) + '</div></div>' +
        '<div class="qty-control">' +
        '<button data-act="dec">−</button><span>' + item.quantidade + '</span><button data-act="inc">+</button></div>' +
        '<button class="remove-btn" data-act="remove">Remover</button></div>'
      ).join('');
      const subtotal = enriched.reduce((s, i) => s + Number(i.preco) * i.quantidade, 0);
      const shipping = subtotal >= 200 ? 0 : 19.9;
      const total = subtotal + shipping;
      c.innerHTML =
        '<div class="cart-layout"><div class="cart-items">' + rows + '</div>' +
        '<aside class="cart-summary"><h3>Resumo</h3>' +
        '<div class="summary-row"><span>Subtotal</span><span>' + formatPrice(subtotal) + '</span></div>' +
        '<div class="summary-row"><span>Frete</span><span>' + (shipping === 0 ? 'Grátis' : formatPrice(shipping)) + '</span></div>' +
        '<div class="summary-total"><span>Total</span><span>' + formatPrice(total) + '</span></div>' +
        '<button class="btn-primary" id="checkout-btn">Finalizar compra</button></aside></div>';

      // Cart item controls
      c.querySelectorAll('.cart-item').forEach(el => {
        const itemId = parseInt(el.dataset.id);
        const cur = enriched.find(i => i.id === itemId);
        el.querySelector('[data-act="inc"]').addEventListener('click', () => updateItemQty(itemId, cur.quantidade + 1).then(draw));
        el.querySelector('[data-act="dec"]').addEventListener('click', () => {
          if (cur.quantidade <= 1) { removeItem(itemId).then(draw); return; }
          updateItemQty(itemId, cur.quantidade - 1).then(draw);
        });
        el.querySelector('[data-act="remove"]').addEventListener('click', () => removeItem(itemId).then(draw));
      });

      // Finalizar → abre modal de checkout
      c.querySelector('#checkout-btn').addEventListener('click', () => abrirCheckout(enriched, subtotal, shipping, total));
    }
    draw();
  }

  /* ─────────── Checkout Modal ─────────── */
  let checkoutData = { step: 1, enriched: [], subtotal: 0, shipping: 0, total: 0 };

  function abrirCheckout(enriched, subtotal, shipping, total) {
    checkoutData = { step: 1, enriched, subtotal, shipping, total };
    const overlay = document.getElementById('checkout-overlay');
    if (!overlay) { showToast('Erro: modal de checkout não encontrado'); return; }
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Step 1: Resumo
    const itemsEl = document.getElementById('checkout-items');
    itemsEl.innerHTML = enriched.map(i =>
      '<div class="checkout-item"><span>' + i.nome + ' x' + i.quantidade + '</span><span>' + formatPrice(Number(i.preco) * i.quantidade) + '</span></div>'
    ).join('');
    document.getElementById('checkout-total-value').textContent = formatPrice(total);

    mostrarStep(1);
  }

  function mostrarStep(n) {
    checkoutData.step = n;
    for (let i = 1; i <= 4; i++) {
      document.getElementById('checkout-step-' + i).style.display = i === n ? 'block' : 'none';
      const ind = document.getElementById('step-indicator-' + i);
      ind.className = 'checkout-step' + (i === n ? ' active' : i < n ? ' done' : '');
    }
  }

  function getEnderecoCompleto() {
    const cep = document.getElementById('checkout-cep').value.trim();
    const rua = document.getElementById('checkout-rua').value.trim();
    const num = document.getElementById('checkout-numero').value.trim();
    const comp = document.getElementById('checkout-complemento').value.trim();
    const bairro = document.getElementById('checkout-bairro').value.trim();
    const cidade = document.getElementById('checkout-cidade').value.trim();
    const uf = document.getElementById('checkout-uf').value.trim().toUpperCase();
    const partes = [rua + ', ' + num, comp ? comp : null, bairro, cidade + ' - ' + uf, 'CEP: ' + cep];
    return partes.filter(p => p).join(', ');
  }

  function initCheckoutModal() {
    const overlay = document.getElementById('checkout-overlay');
    if (!overlay) return;

    // Close
    document.getElementById('checkout-close').addEventListener('click', fecharCheckout);
    overlay.addEventListener('click', function (e) { if (e.target === this) fecharCheckout(); });

    // Step 1 → 2
    document.getElementById('checkout-go-2').addEventListener('click', () => mostrarStep(2));

    // Step 2 → 3
    document.getElementById('checkout-go-3').addEventListener('click', () => {
      const rua = document.getElementById('checkout-rua').value.trim();
      const num = document.getElementById('checkout-numero').value.trim();
      const bairro = document.getElementById('checkout-bairro').value.trim();
      const cidade = document.getElementById('checkout-cidade').value.trim();
      const uf = document.getElementById('checkout-uf').value.trim();
      if (!rua) { showToast('Preencha o nome da rua'); return; }
      if (!num) { showToast('Preencha o número'); return; }
      if (!bairro) { showToast('Preencha o bairro'); return; }
      if (!cidade) { showToast('Preencha a cidade'); return; }
      if (!uf || uf.length !== 2) { showToast('Preencha a UF (sigla de 2 letras)'); return; }
      mostrarStep(3);
    });

    // Step 3 → 4
    document.getElementById('checkout-go-4').addEventListener('click', () => {
      const pagamento = document.querySelector('input[name="pagamento"]:checked');
      if (!pagamento) { showToast('Selecione uma forma de pagamento'); return; }
      document.getElementById('confirm-endereco').textContent = getEnderecoCompleto();
      document.getElementById('confirm-pagamento').textContent = pagamento.value;
      document.getElementById('confirm-obs').textContent = document.getElementById('checkout-obs').value.trim() || '—';
      document.getElementById('confirm-total').textContent = formatPrice(checkoutData.total);
      mostrarStep(4);
    });

    // Step 4 back
    document.getElementById('checkout-back-3').addEventListener('click', () => mostrarStep(3));

    // Confirmar e finalizar
    document.getElementById('checkout-confirm').addEventListener('click', async () => {
      const btn = document.getElementById('checkout-confirm');
      btn.disabled = true; btn.textContent = 'Finalizando...';

      try {
        const pagamento = document.querySelector('input[name="pagamento"]:checked').value;
        // 1. Salvar checkout (endereço + pagamento)
        await apiFetch('/pedidos/' + currentOrderId + '/checkout', {
          method: 'PUT',
          body: {
            endereco_entrega: getEnderecoCompleto(),
            metodo_pagamento: pagamento,
            observacoes: document.getElementById('checkout-obs').value.trim() || ''
          }
        });

        // 2. Finalizar pedido
        await finalizeOrder();

        // 3. Sucesso!
        fecharCheckout();
        showToast('Pedido #' + currentOrderId + ' finalizado com sucesso!');
        setTimeout(() => { window.location.href = 'meus-pedidos.html'; }, 1000);
      } catch (e) {
        showToast(e.message);
        btn.disabled = false; btn.textContent = '✓ Confirmar e Finalizar';
      }
    });
  }

  function fecharCheckout() {
    document.getElementById('checkout-overlay').style.display = 'none';
    document.body.style.overflow = '';
    // Recarrega o carrinho
    const c = document.getElementById('cart-page-content');
    if (c) renderCartPage();
  }

  /* ─────────── Auth Forms ─────────── */
  function renderAuthForm(type) {
    const c = document.getElementById('auth-form'); if (!c) return;
    const isLogin = type === 'login';
    document.title = (isLogin ? 'Login' : 'Cadastro') + ' - Fluffy Dreams';
    c.innerHTML =
      '<div class="auth-box">' +
      '<h1>' + (isLogin ? 'Entrar' : 'Criar Conta') + '</h1>' +
      (isLogin ? '' : '<div class="field"><label>Nome</label><input type="text" id="auth-nome" placeholder="Seu nome" /></div>') +
      '<div class="field"><label>Email</label><input type="email" id="auth-email" placeholder="seu@email.com" /></div>' +
      '<div class="field"><label>Senha</label><input type="password" id="auth-senha" placeholder="Sua senha" /></div>' +
      '<button class="btn-primary" id="auth-submit">' + (isLogin ? 'Entrar' : 'Cadastrar') + '</button>' +
      '<p class="auth-link">' +
      (isLogin ? 'Não tem conta? <a href="register.html">Cadastre-se</a>' : 'Já tem conta? <a href="login.html">Entrar</a>') +
      '</p></div>';
    document.getElementById('auth-submit').addEventListener('click', async () => {
      const email = document.getElementById('auth-email').value.trim();
      const senha = document.getElementById('auth-senha').value;
      const body = isLogin ? { email, senha } : { nome: document.getElementById('auth-nome').value.trim(), email, senha };
      try {
        const data = await apiFetch('/auth/' + (isLogin ? 'login' : 'register'), { method: 'POST', body });
        if (isLogin) {
          setToken(data.token);
          const payload = JSON.parse(atob(data.token.split('.')[1]));
          setUser({ id: payload.id, nome: payload.nome, email: payload.email });
          window.location.href = 'index.html';
        } else {
          showToast('Conta criada! Faça login.');
          setTimeout(() => window.location.href = 'login.html', 1200);
        }
      } catch (e) { showToast(e.message); }
    });
  }

  /* ─────────── Header Auth ─────────── */
  function updateHeaderAuth() {
    const user = getUser();
    document.querySelectorAll('.login-link').forEach(a => a.style.display = user ? 'none' : '');
    document.querySelectorAll('.account-link').forEach(a => a.style.display = user ? '' : 'none');
    document.querySelectorAll('.user-name').forEach(el => el.textContent = user ? (user.nome || user.email) : '');
  }

  /* ─────────── Orders Page ─────────── */
  async function renderOrdersPage() {
    const c = document.getElementById('orders-content'); if (!c) return;
    if (!isLoggedIn()) {
      c.innerHTML = '<div class="empty-state"><h2>Faça login para ver seus pedidos</h2><a class="btn-primary" href="login.html">Entrar</a></div>';
      return;
    }
    try {
      c.innerHTML = '<div class="loading-spinner"></div>';
      const orders = await apiFetch('/pedidos');
      if (!orders || orders.length === 0) {
        c.innerHTML = '<div class="empty-state"><h2>Nenhum pedido ainda</h2><p>Que tal fazer sua primeira compra?</p><a class="btn-primary" href="index.html">Ver produtos</a></div>';
        return;
      }
      c.innerHTML = '<div class="orders-list">';
      orders.forEach(o => {
        const items = o.itens && o.itens.length > 0
          ? o.itens.map(i => '<div class="order-item"><span>' + i.nome + ' x' + i.quantidade + '</span><span>' + formatPrice(i.preco_unitario * i.quantidade) + '</span></div>').join('')
          : '<div class="order-item"><span>Carrinho vazio</span></div>';
        c.innerHTML +=
          '<div class="order-card">' +
          '<div class="order-header">' +
          '<span>Pedido #' + o.id + '</span>' +
          statusBadge(o.status) +
          '<span class="order-date">' + new Date(o.data_pedido).toLocaleDateString('pt-BR') + '</span>' +
          '<span class="order-total">' + formatPrice(o.total) + '</span>' +
          '</div>' +
          '<div class="order-body">' + items + '</div>' +
          '</div>';
      });
      c.innerHTML += '</div>';
    } catch (e) {
      c.innerHTML = '<div class="empty-state"><h2>Erro ao carregar pedidos</h2></div>';
    }
  }

  /* ─────────── Admin Page ─────────── */
  async function renderAdmin() {
    const c = document.getElementById('admin-content'); if (!c) return;
    if (!isLoggedIn()) { c.innerHTML = '<div class="empty-state"><h2>Faça login como admin</h2></div>'; return; }
    try {
      c.innerHTML = '<div class="loading-spinner"></div>';
      const [pedidos, usuarios, produtos] = await Promise.all([
        apiFetch('/admin/pedidos'),
        apiFetch('/admin/usuarios'),
        apiFetch('/produtos'),
      ]);
      const totalVendas = pedidos.filter(p => p.status === 'FINALIZADO').reduce((s, p) => s + Number(p.total), 0);
      c.innerHTML =
        '<div class="admin-stats">' +
        '<div class="stat-card"><strong>' + produtos.length + '</strong><span>Produtos</span></div>' +
        '<div class="stat-card"><strong>' + usuarios.length + '</strong><span>Usuários</span></div>' +
        '<div class="stat-card"><strong>' + pedidos.length + '</strong><span>Pedidos</span></div>' +
        '<div class="stat-card"><strong>' + formatPrice(totalVendas) + '</strong><span>Vendas</span></div>' +
        '</div>' +
        '<h3>Últimos Pedidos</h3><div class="admin-table-wrap"><table class="admin-table"><tr><th>#</th><th>Usuário</th><th>Total</th><th>Status</th><th>Data</th></tr>' +
        pedidos.slice(0, 20).map(p =>
          '<tr><td>' + p.id + '</td><td>' + (p.usuario_nome || '') + '</td><td>' + formatPrice(p.total) + '</td><td>' + statusBadge(p.status) + '</td><td>' + new Date(p.data_pedido).toLocaleDateString('pt-BR') + '</td></tr>'
        ).join('') + '</table></div>' +
        '<h3>Produtos</h3><div class="admin-table-wrap"><table class="admin-table"><tr><th>ID</th><th>Nome</th><th>Preço</th><th>Estoque</th><th>Status</th></tr>' +
        produtos.map(p =>
          '<tr><td>' + p.id + '</td><td>' + p.nome + '</td><td>' + formatPrice(p.preco) + '</td><td>' + p.quantidade_estoque + '</td><td>' + (p.status ? '<span style="color:#10b981">Ativo</span>' : '<span style="color:#ef4444">Inativo</span>') + '</td></tr>'
        ).join('') + '</table></div>';
    } catch (e) {
      c.innerHTML = '<div class="empty-state"><h2>Erro ao carregar admin</h2></div>';
    }
  }

  /* ─────────── Init ─────────── */
  document.addEventListener('DOMContentLoaded', function () {
    updateHeaderAuth();
    updateBadges();
    renderBanner();
    renderCatalog();
    renderProductPage();
    renderCartPage();
    initCheckoutModal();
    renderOrdersPage();
    renderAdmin();

    const page = document.body.dataset.page;
    if (page === 'login') renderAuthForm('login');
    if (page === 'register') renderAuthForm('register');

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function (e) {
        e.preventDefault();
        clearToken(); clearUser();
        localStorage.removeItem('fluffy_order_id');
        currentOrderId = null; orderIdPromise = null;
        showToast('Sessão encerrada');
        updateHeaderAuth(); updateBadges();
        // reload if on orders/admin
        const p = document.body.dataset.page;
        if (p === 'orders' || p === 'admin') setTimeout(() => location.reload(), 500);
      });
    }
  });
})();
