const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const initializeDatabase = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// Função auxiliar para registrar logs de auditoria
async function logAction(db, userId, action, details) {
  try {
    const user = await db.get('SELECT username FROM users WHERE id = ?', [userId]);
    const username = user ? user.username : 'Sistema';
    await db.run(
      'INSERT INTO audit_logs (user_id, username, action, details) VALUES (?, ?, ?, ?)',
      [userId, username, action, details]
    );
  } catch (error) {
    console.error("Falha ao registrar ação de auditoria:", error);
  }
}

async function startServer() {
  const db = await initializeDatabase();

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

  console.log('Banco de dados inicializado. Configurando rotas da API...');

  // --- ROTAS DA APLICAÇÃO ---

  app.get('/auditoria', async (req, res) => {
    try {
      const logs = await db.all('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100');
      res.status(200).json(logs);
    } catch (error) { console.error("Erro ao buscar logs de auditoria:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const user = await db.get('SELECT id, username, tipo_usuario FROM users WHERE username = ? AND password = ?', [username, password]);
      if (user) {
        await logAction(db, user.id, 'LOGIN', `Usuário '${user.username}' efetuou login.`);
        res.status(200).json({ message: 'Login bem-sucedido!', user });
      } else { res.status(401).json({ message: 'Credenciais inválidas.' }); }
    } catch (error) { console.error("Erro na rota /login:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/users/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const requestingUser = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
      if (!requestingUser) { return res.status(404).json({ message: 'Usuário solicitante não encontrado.' }); }
      if (requestingUser.tipo_usuario === 'M') {
        const trainers = await db.all("SELECT id, username, image_url FROM users WHERE tipo_usuario = 'T'");
        res.status(200).json(trainers);
      } else if (requestingUser.tipo_usuario === 'T') {
        const self = await db.get("SELECT id, username, image_url FROM users WHERE id = ?", [userId]);
        res.status(200).json([self]);
      }
    } catch (error) { console.error("Erro na rota /users/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/users/register', upload.single('imageFile'), async (req, res) => {
    const { username, password } = req.body;
    try {
      if (!username || !password) { return res.status(400).json({ message: 'Nome de usuário e senha são obrigatórios.' }); }
      const existingUser = await db.get('SELECT id FROM users WHERE username = ?', [username]);
      if (existingUser) { return res.status(409).json({ message: 'Este nome de usuário já está em uso.' }); }
      let imageUrl = 'https://i.imgur.com/6MKOJ1G.png';
      if (req.file) { imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`; }
      const result = await db.run("INSERT INTO users (username, password, image_url, tipo_usuario) VALUES (?, ?, ?, 'T')", [username, password, imageUrl]);
      await logAction(db, 1, 'CADASTRO_TREINADOR', `O treinador '${username}' (ID: ${result.lastID}) foi criado.`);
      res.status(201).json({ message: 'Treinador cadastrado com sucesso!', userId: result.lastID });
    } catch (error) { console.error("Erro na rota /users/register:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/user/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const user = await db.get('SELECT id, username, image_url FROM users WHERE id = ?', [id]);
      if (user) { res.status(200).json(user); }
      else { res.status(404).json({ message: 'Usuário não encontrado.' }); }
    } catch (error) { console.error("Erro na rota /user/:id:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/user/:id', upload.single('imageFile'), async (req, res) => {
    const { id } = req.params;
    const { username, password } = req.body;
    try {
      const currentUser = await db.get('SELECT username, image_url FROM users WHERE id = ?', [id]);
      if (!currentUser) { return res.status(404).json({ message: 'Usuário não encontrado para atualizar.' }); }
      const updates = []; const params = []; let logDetails = [];
      if (username && username !== currentUser.username) { updates.push('username = ?'); params.push(username); logDetails.push(`Nome: '${currentUser.username}' -> '${username}'`);}
      if (password) { updates.push('password = ?'); params.push(password); logDetails.push(`Senha alterada.`);}
      if (req.file) {
        const newImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        updates.push('image_url = ?'); params.push(newImageUrl); logDetails.push(`Imagem alterada.`);
        const defaultImage = 'https://i.imgur.com/6MKOJ1G.png';
        if (currentUser.image_url && currentUser.image_url !== defaultImage && currentUser.image_url.includes('/uploads/')) {
          const oldImageName = currentUser.image_url.split('/uploads/')[1];
          if (oldImageName) { fs.unlink(`uploads/${oldImageName}`, (err) => { if (err) console.error("Erro ao deletar imagem antiga:", err); }); }
        }
      }
      if (updates.length === 0) { return res.status(400).json({ message: 'Nenhum dado fornecido para atualização.' }); }
      const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
      params.push(id);
      await db.run(query, params);
      await logAction(db, 1, 'EDITOU_TREINADOR', `Atualizou perfil de '${currentUser.username}' (ID: ${id}). Detalhes: ${logDetails.join('; ')}`);
      res.status(200).json({ message: 'Treinador atualizado com sucesso!' });
    } catch (error) { console.error("Erro na rota PUT /user/:id:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.delete('/user/:id', async (req, res) => {
    const { id } = req.params;
    try {
      const userToDelete = await db.get('SELECT username, image_url FROM users WHERE id = ?', [id]);
      if (!userToDelete) { return res.status(404).json({ message: 'Usuário não encontrado para exclusão.' }); }
      const pokemonsOfUser = await db.all('SELECT id FROM pokemons WHERE trainer_id = ?', [id]);
      for (const p of pokemonsOfUser) { await db.run('DELETE FROM pokemon_sheets WHERE pokemon_id = ?', [p.id]); }
      await db.run('DELETE FROM pokemons WHERE trainer_id = ?', [id]);
      await db.run('DELETE FROM trainer_sheets WHERE user_id = ?', [id]);
      await db.run('DELETE FROM pokedex WHERE user_id = ?', [id]);
      await db.run('DELETE FROM mochila_itens WHERE user_id = ?', [id]);
      await db.run('DELETE FROM users WHERE id = ?', [id]);
      const defaultImage = 'https://i.imgur.com/6MKOJ1G.png';
      if (userToDelete.image_url && userToDelete.image_url !== defaultImage && userToDelete.image_url.includes('/uploads/')) {
        const oldImageName = userToDelete.image_url.split('/uploads/')[1];
        if (oldImageName) { fs.unlink(`uploads/${oldImageName}`, (err) => { if (err) console.error("Erro ao deletar a imagem do usuário:", err); }); }
      }
      await logAction(db, 1, 'EXCLUSÃO_DE_TREINADOR', `O treinador '${userToDelete.username}' (ID: ${id}) e todos os seus dados foram excluídos.`);
      res.status(200).json({ message: 'Treinador e todos os seus dados foram excluídos com sucesso!' });
    } catch (error) { console.error("Erro na rota DELETE /user/:id:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/trainer/:id/pokemons', async (req, res) => {
    const { id } = req.params;
    try {
      const pokemons = await db.all("SELECT * FROM pokemons WHERE trainer_id = ? AND status = 'U'", [id]);
      res.status(200).json(pokemons);
    } catch (error) { console.error("Erro na rota /trainer/:id/pokemons:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/pokemons', upload.single('imageFile'), async (req, res) => {
    const { name, type, level, trainer_id, image_url } = req.body;
    try {
      if (!name || !type || !level || !trainer_id) { return res.status(400).json({ message: 'Todos os campos são obrigatórios.' }); }
      const team = await db.all('SELECT id FROM pokemons WHERE trainer_id = ? AND status = "U"', [trainer_id]);
      if (team.length >= 6) { return res.status(403).json({ message: 'Limite de 6 Pokémon por equipe atingido!' }); }
      let finalImageUrl = 'https://i.imgur.com/bTf0PCo.png';
      if (req.file) { finalImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`; }
      else if (image_url) { finalImageUrl = image_url; }
      const result = await db.run('INSERT INTO pokemons (name, type, level, image_url, trainer_id) VALUES (?, ?, ?, ?, ?)', [name, type, level, finalImageUrl, trainer_id]);
      await logAction(db, trainer_id, 'ADICIONOU_POKEMON', `Adicionou '${name}' à equipe.`);
      res.status(201).json({ message: 'Pokémon cadastrado com sucesso!', pokemonId: result.lastID });
    } catch (error) { console.error("Erro na rota /pokemons:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/pokemon-stats/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    const { level, xp, max_hp, current_hp } = req.body;
    try {
      const oldPokemon = await db.get('SELECT * FROM pokemons WHERE id = ?', [pokemonId]);
      if (!oldPokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
      await db.run( `UPDATE pokemons SET level = ?, xp = ?, max_hp = ?, current_hp = ? WHERE id = ?`, [level, xp, max_hp, current_hp, pokemonId] );
      const updatedPokemon = await db.get('SELECT * FROM pokemons WHERE id = ?', [pokemonId]);
      let logDetails = [];
      if (oldPokemon.level !== level) logDetails.push(`Level: ${oldPokemon.level} -> ${level}`);
      if (oldPokemon.xp !== xp) logDetails.push(`XP: ${oldPokemon.xp} -> ${xp}`);
      if (oldPokemon.max_hp !== max_hp) logDetails.push(`HP Máx: ${oldPokemon.max_hp} -> ${max_hp}`);
      if (oldPokemon.current_hp !== current_hp) logDetails.push(`HP Atual: ${oldPokemon.current_hp} -> ${current_hp}`);
      if (logDetails.length > 0) { await logAction(db, updatedPokemon.trainer_id, 'EDITOU_POKEMON', `Stats de '${updatedPokemon.name}' atualizados: ${logDetails.join(', ')}.`); }
      res.status(200).json({ message: 'Stats do Pokémon atualizados com sucesso!', pokemon: updatedPokemon });
    } catch (error) { console.error("Erro ao atualizar stats do Pokémon:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });
  
  app.delete('/pokemon/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    try {
      const pokemonToDelete = await db.get('SELECT name, trainer_id, image_url FROM pokemons WHERE id = ?', [pokemonId]);
      if (!pokemonToDelete) { return res.status(404).json({ message: 'Pokémon não encontrado para exclusão.' }); }
      await db.run('DELETE FROM pokemon_sheets WHERE pokemon_id = ?', [pokemonId]);
      await db.run('DELETE FROM pokemons WHERE id = ?', [pokemonId]);
      if (pokemonToDelete.image_url && pokemonToDelete.image_url.includes('/uploads/')) {
        const oldImageName = pokemonToDelete.image_url.split('/uploads/')[1];
        if (oldImageName) { fs.unlink(`uploads/${oldImageName}`, (err) => { if (err) console.error("Erro ao deletar a imagem do pokémon:", err); }); }
      }
      await logAction(db, pokemonToDelete.trainer_id, 'LIBEROU_POKEMON', `O pokémon '${pokemonToDelete.name}' foi liberado.`);
      res.status(200).json({ message: 'Pokémon excluído com sucesso!' });
    } catch (error) { console.error("Erro ao excluir Pokémon:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/pokemon/:pokemonId/deposit', async (req, res) => {
    const { pokemonId } = req.params;
    try {
      const pokemon = await db.get('SELECT name, trainer_id FROM pokemons WHERE id = ?', [pokemonId]);
      await db.run("UPDATE pokemons SET status = 'D' WHERE id = ?", [pokemonId]);
      await logAction(db, pokemon.trainer_id, 'DEPOSITOU_POKEMON', `O pokémon '${pokemon.name}' foi depositado.`);
      res.status(200).json({ message: 'Pokémon depositado com sucesso!' });
    } catch (error) { console.error("Erro na rota /pokemon/:pokemonId/deposit:", error); res.status(500).json({ message: 'Erro ao depositar o Pokémon.' }); }
  });

  app.put('/pokemon/:pokemonId/withdraw', async (req, res) => {
    const { pokemonId } = req.params;
    try {
      const pokemon = await db.get('SELECT name, trainer_id FROM pokemons WHERE id = ?', [pokemonId]);
      if (!pokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
      const { trainer_id } = pokemon;
      const team = await db.all("SELECT id FROM pokemons WHERE trainer_id = ? AND status = 'U'", [trainer_id]);
      if (team.length >= 6) { return res.status(403).json({ message: 'A equipe do treinador já está cheia (limite de 6 Pokémon)! Não é possível retirar.' }); }
      await db.run("UPDATE pokemons SET status = 'U' WHERE id = ?", [pokemonId]);
      await logAction(db, trainer_id, 'RETUROU_POKEMON', `O pokémon '${pokemon.name}' foi retirado do depósito.`);
      res.status(200).json({ message: 'Pokémon retirado do depósito e adicionado à equipe!' });
    } catch (error) { console.error("Erro ao retirar Pokémon:", error); res.status(500).json({ message: 'Erro ao retirar o Pokémon.' }); }
  });

  app.get('/deposito/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const pokemons = await db.all("SELECT * FROM pokemons WHERE trainer_id = ? AND status = 'D'", [userId]);
      res.status(200).json(pokemons);
    } catch (error) { console.error("Erro na rota /deposito/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/ficha/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const sheet = await db.get('SELECT * FROM trainer_sheets WHERE user_id = ?', [userId]);
      if (sheet) {
        sheet.vantagens = JSON.parse(sheet.vantagens_json || '[]');
        sheet.atributos = JSON.parse(sheet.atributos_json || '{}');
        sheet.pericias = JSON.parse(sheet.pericias_json || '{}');
        res.status(200).json(sheet);
      } else { res.status(404).json({ message: 'Nenhuma ficha encontrada para este treinador.' }); }
    } catch (error) { console.error("Erro na rota /ficha/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/ficha/:userId', async (req, res) => {
    const { userId } = req.params;
    const dados = req.body;
    try {
      await db.run( `INSERT INTO trainer_sheets (user_id, nome, peso, idade, altura, cidade, regiao, xp, hp, level, vantagens_json, atributos_json, pericias_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET nome=excluded.nome, peso=excluded.peso, idade=excluded.idade, altura=excluded.altura, cidade=excluded.cidade, regiao=excluded.regiao, xp=excluded.xp, hp=excluded.hp, level=excluded.level, vantagens_json=excluded.vantagens_json, atributos_json=excluded.atributos_json, pericias_json=excluded.pericias_json`, [userId, dados.nome, dados.peso, dados.idade, dados.altura, dados.cidade, dados.regiao, dados.xp, dados.hp, dados.level, JSON.stringify(dados.vantagens), JSON.stringify(dados.atributos), JSON.stringify(dados.pericias)]);
      await logAction(db, userId, 'SALVOU_FICHA_TREINADOR', `A ficha do treinador '${dados.nome}' foi salva.`);
      res.status(200).json({ message: 'Ficha salva com sucesso!' });
    } catch (error) { console.error("Erro na rota PUT /ficha/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/pokedex/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const entries = await db.all('SELECT * FROM pokedex WHERE user_id = ? ORDER BY id ASC', [userId]);
      res.status(200).json(entries);
    } catch (error) { console.error("Erro ao buscar dados da Pokédex:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/pokedex', async (req, res) => {
    const { id, name, type, image_url, user_id } = req.body;
    try {
      if (!id || !name || !type || !image_url || !user_id) { return res.status(400).json({ message: 'Dados incompletos para adicionar à Pokédex.' }); }
      await db.run('INSERT OR IGNORE INTO pokedex (id, user_id, name, type, image_url) VALUES (?, ?, ?, ?, ?)', [id, user_id, name, type, image_url]);
      await logAction(db, user_id, 'ADICIONOU_POKEDEX', `Adicionou '${name}' à sua Pokédex.`);
      res.status(201).json({ message: `${name} adicionado à Pokédex!` });
    } catch (error) { console.error("Erro ao adicionar na Pokédex:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/mochila/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const itens = await db.all('SELECT * FROM mochila_itens WHERE user_id = ? ORDER BY item_nome ASC', [userId]);
      res.status(200).json(itens);
    } catch (error) { console.error("Erro ao buscar itens da mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/mochila/item', async (req, res) => {
    const { user_id, item_nome, quantidade } = req.body;
    if (!user_id || !item_nome || !quantidade) { return res.status(400).json({ message: 'Dados incompletos para adicionar o item.' }); }
    try {
      const itemExistente = await db.get('SELECT * FROM mochila_itens WHERE user_id = ? AND item_nome = ?', [user_id, item_nome]);
      let itemFinal;
      if (itemExistente) {
        const novaQuantidade = itemExistente.quantidade + parseInt(quantidade, 10);
        await db.run('UPDATE mochila_itens SET quantidade = ? WHERE id = ?', [novaQuantidade, itemExistente.id]);
        itemFinal = { ...itemExistente, quantidade: novaQuantidade };
        res.status(200).json(itemFinal);
      } else {
        const result = await db.run('INSERT INTO mochila_itens (user_id, item_nome, quantidade) VALUES (?, ?, ?)', [user_id, item_nome, quantidade]);
        itemFinal = { id: result.lastID, user_id, item_nome, quantidade };
        res.status(201).json(itemFinal);
      }
      await logAction(db, user_id, 'ADICIONOU_ITEM', `Adicionou ${quantidade}x '${item_nome}' à mochila.`);
    } catch (error) { console.error("Erro ao adicionar item na mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.delete('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    try {
      const item = await db.get('SELECT * FROM mochila_itens WHERE id = ?', [itemId]);
      if (!item) return res.status(404).json({ message: "Item não encontrado." });
      await db.run('DELETE FROM mochila_itens WHERE id = ?', [itemId]);
      await logAction(db, item.user_id, 'REMOVEU_ITEM', `Removeu ${item.quantidade}x '${item.item_nome}' da mochila.`);
      res.status(200).json({ message: 'Item removido com sucesso!' });
    } catch (error) { console.error("Erro ao remover item da mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    const { quantidade } = req.body;
    const novaQuantidade = parseInt(quantidade, 10);
    if (isNaN(novaQuantidade)) { return res.status(400).json({ message: 'Quantidade inválida.' }); }
    try {
      const item = await db.get('SELECT * FROM mochila_itens WHERE id = ?', [itemId]);
      if (!item) return res.status(404).json({ message: "Item não encontrado." });
      if (novaQuantidade <= 0) {
        await db.run('DELETE FROM mochila_itens WHERE id = ?', [itemId]);
        await logAction(db, item.user_id, 'REMOVEU_ITEM', `Removeu o restante de '${item.item_nome}' da mochila.`);
        res.status(200).json({ message: 'Item removido da mochila.' });
      } else {
        await db.run('UPDATE mochila_itens SET quantidade = ? WHERE id = ?', [novaQuantidade, itemId]);
        const itemAtualizado = await db.get('SELECT * FROM mochila_itens WHERE id = ?', [itemId]);
        await logAction(db, item.user_id, 'EDITOU_ITEM', `Alterou a quantidade de '${item.item_nome}': ${item.quantidade} -> ${novaQuantidade}.`);
        res.status(200).json(itemAtualizado);
      }
    } catch (error) { console.error("Erro ao atualizar item na mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  // 4. Inicia o servidor
  app.listen(PORT, () => console.log(`🚀 Backend rodando em http://localhost:${PORT}`));
}

startServer();