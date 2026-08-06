const jwt = require('jsonwebtoken');

function autenticar(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido' });
  }
  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.usuarioId = decoded.id;
    req.usuarioEmail = decoded.email;
    next();
  } catch {
    return res.status(403).json({ error: 'Token inválido ou expirado' });
  }
}

module.exports = { autenticar };
