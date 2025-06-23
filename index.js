const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const initializeDatabase = require('./database');

const app = express();
const PORT = 3001;

// Função auxiliar para registrar logs de auditoria
async function logAction(pool, userId, action, details) {
  try {
    let username = 'Sistema';
    if (userId) {
      const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
      if (rows.length > 0) username = rows[0].username;
    }
    await pool.query(
      'INSERT INTO audit_logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
      [userId, username, action, details]
    );
  } catch (error) {
    console.error("Falha ao registrar ação de auditoria:", error);
  }
}

async function startServer() {
  const pool = await initializeDatabase();

  // Middlewares
  app.use(cors());
  app.use(express.json());
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Configuração do Multer
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
  });
  const upload = multer({ storage: storage });

  // --- ROTAS DA APLICAÇÃO ---

  app.get('/auditoria', async (req, res) => {
    try {
      const { rows: logs } = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100');
      res.status(200).json(logs);
    } catch (error) { console.error("Erro ao buscar logs de auditoria:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const { rows } = await pool.query('SELECT id, username, tipo_usuario FROM users WHERE username = $1 AND password = $2', [username, password]);
      const user = rows[0];
      if (user) {
        await logAction(pool, user.id, 'LOGIN', `Usuário '${user.username}' efetuou login.`);
        res.status(200).json({ message: 'Login bem-sucedido!', user });
      } else { res.status(401).json({ message: 'Credenciais inválidas.' }); }
    } catch (error) { console.error("Erro na rota /login:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: requestingRows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      const requestingUser = requestingRows[0];
      if (!requestingUser) { return res.status(404).json({ message: 'Usuário solicitante não encontrado.' }); }
      if (requestingUser.tipo_usuario === 'M') {
        const { rows: trainers } = await pool.query("SELECT id, username, image_url FROM users WHERE tipo_usuario = 'T'");
        res.status(200).json(trainers);
      } else if (requestingUser.tipo_usuario === 'T') {
        const { rows } = await pool.query("SELECT id, username, image_url FROM users WHERE id = $1", [userId]);
        res.status(200).json(rows);
      }
    } catch (error) { console.error("Erro na rota /users/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/users/register', upload.single('imageFile'), async (req, res) => {
    const { username, password } = req.body;
    try {
      if (!username || !password) { return res.status(400).json({ message: 'Nome de usuário e senha são obrigatórios.' }); }
      const { rows: existingRows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
      if (existingRows.length > 0) { return res.status(409).json({ message: 'Este nome de usuário já está em uso.' }); }
      let imageUrl = 'https://i.imgur.com/6MKOJ1G.png';
      if (req.file) { imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`; }
      const { rows } = await pool.query("INSERT INTO users (username, password, image_url, tipo_usuario) VALUES ($1, $2, $3, 'T') RETURNING id", [username, password, imageUrl]);
      await logAction(pool, 1, 'CADASTRO_TREINADOR', `O treinador '${username}' (ID: ${rows[0].id}) foi criado.`);
      res.status(201).json({ message: 'Treinador cadastrado com sucesso!', userId: rows[0].id });
    } catch (error) { console.error("Erro na rota /users/register:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/user/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const { rows } = await pool.query('SELECT id, username, image_url FROM users WHERE id = $1', [id]);
      const user = rows[0];
      if (user) { res.status(200).json(user); }
      else { res.status(404).json({ message: 'Usuário não encontrado.' }); }
    } catch (error) { console.error("Erro na rota /user/:id:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/user/:id', upload.single('imageFile'), async (req, res) => {
    const { id } = req.params;
    const { username, password } = req.body;
    try {
      const { rows: currentRows } = await pool.query('SELECT username, image_url FROM users WHERE id = $1', [id]);
      const currentUser = currentRows[0];
      if (!currentUser) { return res.status(404).json({ message: 'Usuário não encontrado para atualizar.' }); }
      const updates = []; const params = []; let logDetails = [];
      if (username && username !== currentUser.username) { updates.push('username = $' + (params.length + 1)); params.push(username); logDetails.push(`Nome: '${currentUser.username}' -> '${username}'`);}
      if (password) { updates.push('password = $' + (params.length + 1)); params.push(password); logDetails.push(`Senha alterada.`);}
      if (req.file) {
        const newImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        updates.push('image_url = $' + (params.length + 1)); params.push(newImageUrl); logDetails.push(`Imagem alterada.`);
        const defaultImage = 'https://i.imgur.com/6MKOJ1G.png';
        if (currentUser.image_url && currentUser.image_url !== defaultImage && currentUser.image_url.includes('/uploads/')) {
          const oldImageName = currentUser.image_url.split('/uploads/')[1];
          if (oldImageName) { fs.unlink(`uploads/${oldImageName}`, (err) => { if (err) console.error("Erro ao deletar imagem antiga:", err); }); }
        }
      }
      if (updates.length === 0) { return res.status(400).json({ message: 'Nenhum dado fornecido para atualização.' }); }
      const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length + 1}`;
      params.push(id);
      await pool.query(query, params);
      await logAction(pool, 1, 'EDITOU_TREINADOR', `Atualizou perfil de '${currentUser.username}' (ID: ${id}). Detalhes: ${logDetails.join('; ')}`);
      res.status(200).json({ message: 'Treinador atualizado com sucesso!' });
    } catch (error) { console.error("Erro na rota PUT /user/:id:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.delete('/user/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const { rows: userRows } = await pool.query('SELECT username, image_url FROM users WHERE id = $1', [id]);
      const userToDelete = userRows[0];
      if (!userToDelete) { return res.status(404).json({ message: 'Usuário não encontrado para exclusão.' }); }
      const { rows: pokemonsOfUser } = await pool.query('SELECT id FROM pokemons WHERE trainer_id = $1', [id]);
      for (const p of pokemonsOfUser) { await pool.query('DELETE FROM pokemon_sheets WHERE pokemon_id = $1', [p.id]); }
      await pool.query('DELETE FROM pokemons WHERE trainer_id = $1', [id]);
      await pool.query('DELETE FROM trainer_sheets WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM pokedex WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM mochila_itens WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
      const defaultImage = 'https://i.imgur.com/6MKOJ1G.png';
      if (userToDelete.image_url && userToDelete.image_url !== defaultImage && userToDelete.image_url.includes('/uploads/')) {
        const oldImageName = userToDelete.image_url.split('/uploads/')[1];
        if (oldImageName) { fs.unlink(`uploads/${oldImageName}`, (err) => { if (err) console.error("Erro ao deletar a imagem do usuário:", err); }); }
      }
      await logAction(pool, 1, 'EXCLUSÃO_DE_TREINADOR', `O treinador '${userToDelete.username}' (ID: ${id}) e todos os seus dados foram excluídos.`);
      res.status(200).json({ message: 'Treinador e todos os seus dados foram excluídos com sucesso!' });
    } catch (error) { console.error("Erro na rota DELETE /user/:id:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/trainer/:id/pokemons', async (req, res) => {
    const { id } = req.params;
    try {
      const { rows: pokemons } = await pool.query("SELECT * FROM pokemons WHERE trainer_id = $1 AND status = 'U'", [id]);
      res.status(200).json(pokemons);
    } catch (error) { console.error("Erro na rota /trainer/:id/pokemons:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  // ROTAS ADAPTADAS PARA NOVOS CAMPOS DE POKÉMON
  app.post('/pokemons', upload.single('imageFile'), async (req, res) => {
    const {
      name, type, level, xp, max_hp, current_hp,
      especial, especial_total, vigor, vigor_total,
      trainer_id, image_url
    } = req.body;
    try {
      if (!name || !type || !level || !trainer_id) { return res.status(400).json({ message: 'Todos os campos são obrigatórios.' }); }
      const { rows: team } = await pool.query('SELECT id FROM pokemons WHERE trainer_id = $1 AND status = $2', [trainer_id, "U"]);
      if (team.length >= 6) { return res.status(403).json({ message: 'Limite de 6 Pokémon por equipe atingido!' }); }
      let finalImageUrl = 'https://i.imgur.com/bTf0PCo.png';
      if (req.file) { finalImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`; }
      else if (image_url) { finalImageUrl = image_url; }
      const { rows } = await pool.query(
        `INSERT INTO pokemons
          (name, type, level, xp, max_hp, current_hp, especial, especial_total, vigor, vigor_total, image_url, trainer_id)
         VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          name,
          type,
          level ?? 1,
          xp ?? 0,
          max_hp ?? 10,
          current_hp ?? 10,
          especial ?? 10,
          especial_total ?? 10,
          vigor ?? 10,
          vigor_total ?? 10,
          finalImageUrl,
          trainer_id
        ]
      );
      await logAction(pool, trainer_id, 'ADICIONOU_POKEMON', `Adicionou '${name}' à equipe.`);
      res.status(201).json({ message: 'Pokémon cadastrado com sucesso!', pokemonId: rows[0].id });
    } catch (error) { console.error("Erro na rota /pokemons:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/pokemon-stats/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    const {
      level, xp, max_hp, current_hp,
      especial, especial_total, vigor, vigor_total
    } = req.body;
    try {
      const { rows: oldPokemonRows } = await pool.query('SELECT * FROM pokemons WHERE id = $1', [pokemonId]);
      const oldPokemon = oldPokemonRows[0];
      if (!oldPokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
      await pool.query(
        `UPDATE pokemons SET
          level = $1,
          xp = $2,
          max_hp = $3,
          current_hp = $4,
          especial = $5,
          especial_total = $6,
          vigor = $7,
          vigor_total = $8
        WHERE id = $9`,
        [
          level ?? oldPokemon.level,
          xp ?? oldPokemon.xp,
          max_hp ?? oldPokemon.max_hp,
          current_hp ?? oldPokemon.current_hp,
          especial ?? oldPokemon.especial,
          especial_total ?? oldPokemon.especial_total,
          vigor ?? oldPokemon.vigor,
          vigor_total ?? oldPokemon.vigor_total,
          pokemonId
        ]
      );
      const { rows: updatedPokemonRows } = await pool.query('SELECT * FROM pokemons WHERE id = $1', [pokemonId]);
      const updatedPokemon = updatedPokemonRows[0];
      let logDetails = [];
      if (oldPokemon.level !== level) logDetails.push(`Level: ${oldPokemon.level} -> ${level}`);
      if (oldPokemon.xp !== xp) logDetails.push(`XP: ${oldPokemon.xp} -> ${xp}`);
      if (oldPokemon.max_hp !== max_hp) logDetails.push(`HP Máx: ${oldPokemon.max_hp} -> ${max_hp}`);
      if (oldPokemon.current_hp !== current_hp) logDetails.push(`HP Atual: ${oldPokemon.current_hp} -> ${current_hp}`);
      if (oldPokemon.especial !== especial) logDetails.push(`Especial: ${oldPokemon.especial} -> ${especial}`);
      if (oldPokemon.especial_total !== especial_total) logDetails.push(`Especial Total: ${oldPokemon.especial_total} -> ${especial_total}`);
      if (oldPokemon.vigor !== vigor) logDetails.push(`Vigor: ${oldPokemon.vigor} -> ${vigor}`);
      if (oldPokemon.vigor_total !== vigor_total) logDetails.push(`Vigor Total: ${oldPokemon.vigor_total} -> ${vigor_total}`);
      if (logDetails.length > 0) { await logAction(pool, updatedPokemon.trainer_id, 'EDITOU_POKEMON', `Stats de '${updatedPokemon.name}' atualizados: ${logDetails.join(', ')}.`); }
      res.status(200).json({ message: 'Stats do Pokémon atualizados com sucesso!', pokemon: updatedPokemon });
    } catch (error) { console.error("Erro ao atualizar stats do Pokémon:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });


  // Inicia o servidor
  app.listen(PORT, () => console.log(`🚀 Backend rodando em http://localhost:${PORT}`));
}

startServer();
