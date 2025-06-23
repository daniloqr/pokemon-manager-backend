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

  console.log('Banco de dados inicializado. Configurando rotas da API...');

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

  app.post('/pokemons', upload.single('imageFile'), async (req, res) => {
    const { name, type, level, trainer_id, image_url } = req.body;
    try {
      if (!name || !type || !level || !trainer_id) { return res.status(400).json({ message: 'Todos os campos são obrigatórios.' }); }
      const { rows: team } = await pool.query('SELECT id FROM pokemons WHERE trainer_id = $1 AND status = $2', [trainer_id, "U"]);
      if (team.length >= 6) { return res.status(403).json({ message: 'Limite de 6 Pokémon por equipe atingido!' }); }
      let finalImageUrl = 'https://i.imgur.com/bTf0PCo.png';
      if (req.file) { finalImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`; }
      else if (image_url) { finalImageUrl = image_url; }
      const { rows } = await pool.query('INSERT INTO pokemons (name, type, level, image_url, trainer_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [name, type, level, finalImageUrl, trainer_id]);
      await logAction(pool, trainer_id, 'ADICIONOU_POKEMON', `Adicionou '${name}' à equipe.`);
      res.status(201).json({ message: 'Pokémon cadastrado com sucesso!', pokemonId: rows[0].id });
    } catch (error) { console.error("Erro na rota /pokemons:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/pokemon-stats/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    const { level, xp, max_hp, current_hp } = req.body;
    try {
      const { rows: oldPokemonRows } = await pool.query('SELECT * FROM pokemons WHERE id = $1', [pokemonId]);
      const oldPokemon = oldPokemonRows[0];
      if (!oldPokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
      await pool.query( `UPDATE pokemons SET level = $1, xp = $2, max_hp = $3, current_hp = $4 WHERE id = $5`, [level, xp, max_hp, current_hp, pokemonId] );
      const { rows: updatedPokemonRows } = await pool.query('SELECT * FROM pokemons WHERE id = $1', [pokemonId]);
      const updatedPokemon = updatedPokemonRows[0];
      let logDetails = [];
      if (oldPokemon.level !== level) logDetails.push(`Level: ${oldPokemon.level} -> ${level}`);
      if (oldPokemon.xp !== xp) logDetails.push(`XP: ${oldPokemon.xp} -> ${xp}`);
      if (oldPokemon.max_hp !== max_hp) logDetails.push(`HP Máx: ${oldPokemon.max_hp} -> ${max_hp}`);
      if (oldPokemon.current_hp !== current_hp) logDetails.push(`HP Atual: ${oldPokemon.current_hp} -> ${current_hp}`);
      if (logDetails.length > 0) { await logAction(pool, updatedPokemon.trainer_id, 'EDITOU_POKEMON', `Stats de '${updatedPokemon.name}' atualizados: ${logDetails.join(', ')}.`); }
      res.status(200).json({ message: 'Stats do Pokémon atualizados com sucesso!', pokemon: updatedPokemon });
    } catch (error) { console.error("Erro ao atualizar stats do Pokémon:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.delete('/pokemon/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    try {
      const { rows: pokeRows } = await pool.query('SELECT name, trainer_id, image_url FROM pokemons WHERE id = $1', [pokemonId]);
      const pokemonToDelete = pokeRows[0];
      if (!pokemonToDelete) { return res.status(404).json({ message: 'Pokémon não encontrado para exclusão.' }); }
      await pool.query('DELETE FROM pokemon_sheets WHERE pokemon_id = $1', [pokemonId]);
      await pool.query('DELETE FROM pokemons WHERE id = $1', [pokemonId]);
      if (pokemonToDelete.image_url && pokemonToDelete.image_url.includes('/uploads/')) {
        const oldImageName = pokemonToDelete.image_url.split('/uploads/')[1];
        if (oldImageName) { fs.unlink(`uploads/${oldImageName}`, (err) => { if (err) console.error("Erro ao deletar a imagem do pokémon:", err); }); }
      }
      await logAction(pool, pokemonToDelete.trainer_id, 'LIBEROU_POKEMON', `O pokémon '${pokemonToDelete.name}' foi liberado.`);
      res.status(200).json({ message: 'Pokémon excluído com sucesso!' });
    } catch (error) { console.error("Erro ao excluir Pokémon:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/pokemon/:pokemonId/deposit', async (req, res) => {
    const { pokemonId } = req.params;
    try {
      const { rows: pokeRows } = await pool.query('SELECT name, trainer_id FROM pokemons WHERE id = $1', [pokemonId]);
      const pokemon = pokeRows[0];
      await pool.query("UPDATE pokemons SET status = 'D' WHERE id = $1", [pokemonId]);
      await logAction(pool, pokemon.trainer_id, 'DEPOSITOU_POKEMON', `O pokémon '${pokemon.name}' foi depositado.`);
      res.status(200).json({ message: 'Pokémon depositado com sucesso!' });
    } catch (error) { console.error("Erro na rota /pokemon/:pokemonId/deposit:", error); res.status(500).json({ message: 'Erro ao depositar o Pokémon.' }); }
  });

  app.put('/pokemon/:pokemonId/withdraw', async (req, res) => {
    const { pokemonId } = req.params;
    try {
      const { rows: pokeRows } = await pool.query('SELECT name, trainer_id FROM pokemons WHERE id = $1', [pokemonId]);
      const pokemon = pokeRows[0];
      if (!pokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
      const { trainer_id } = pokemon;
      const { rows: team } = await pool.query("SELECT id FROM pokemons WHERE trainer_id = $1 AND status = 'U'", [trainer_id]);
      if (team.length >= 6) { return res.status(403).json({ message: 'A equipe do treinador já está cheia (limite de 6 Pokémon)! Não é possível retirar.' }); }
      await pool.query("UPDATE pokemons SET status = 'U' WHERE id = $1", [pokemonId]);
      await logAction(pool, trainer_id, 'RETUROU_POKEMON', `O pokémon '${pokemon.name}' foi retirado do depósito.`);
      res.status(200).json({ message: 'Pokémon retirado do depósito e adicionado à equipe!' });
    } catch (error) { console.error("Erro ao retirar Pokémon:", error); res.status(500).json({ message: 'Erro ao retirar o Pokémon.' }); }
  });

  app.get('/deposito/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: pokemons } = await pool.query("SELECT * FROM pokemons WHERE trainer_id = $1 AND status = 'D'", [userId]);
      res.status(200).json(pokemons);
    } catch (error) { console.error("Erro na rota /deposito/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/ficha/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows } = await pool.query('SELECT * FROM trainer_sheets WHERE user_id = $1', [userId]);
      const sheet = rows[0];
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
      // UPSERT PostgreSQL: INSERT ... ON CONFLICT (user_id) DO UPDATE ...
      await pool.query(
        `INSERT INTO trainer_sheets 
          (user_id, nome, peso, idade, altura, cidade, regiao, xp, hp, level, vantagens_json, atributos_json, pericias_json) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (user_id) DO UPDATE SET 
            nome = EXCLUDED.nome,
            peso = EXCLUDED.peso,
            idade = EXCLUDED.idade,
            altura = EXCLUDED.altura,
            cidade = EXCLUDED.cidade,
            regiao = EXCLUDED.regiao,
            xp = EXCLUDED.xp,
            hp = EXCLUDED.hp,
            level = EXCLUDED.level,
            vantagens_json = EXCLUDED.vantagens_json,
            atributos_json = EXCLUDED.atributos_json,
            pericias_json = EXCLUDED.pericias_json`,
        [userId, dados.nome, dados.peso, dados.idade, dados.altura, dados.cidade, dados.regiao, dados.xp, dados.hp, dados.level, JSON.stringify(dados.vantagens), JSON.stringify(dados.atributos), JSON.stringify(dados.pericias)]
      );
      await logAction(pool, userId, 'SALVOU_FICHA_TREINADOR', `A ficha do treinador '${dados.nome}' foi salva.`);
      res.status(200).json({ message: 'Ficha salva com sucesso!' });
    } catch (error) { console.error("Erro na rota PUT /ficha/:userId:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/pokedex/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: entries } = await pool.query('SELECT * FROM pokedex WHERE user_id = $1 ORDER BY id ASC', [userId]);
      res.status(200).json(entries);
    } catch (error) { console.error("Erro ao buscar dados da Pokédex:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/pokedex', async (req, res) => {
    const { id, name, type, image_url, user_id } = req.body;
    try {
      if (!id || !name || !type || !image_url || !user_id) { return res.status(400).json({ message: 'Dados incompletos para adicionar à Pokédex.' }); }
      await pool.query(
        `INSERT INTO pokedex (id, user_id, name, type, image_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id, user_id) DO NOTHING`,
        [id, user_id, name, type, image_url]
      );
      await logAction(pool, user_id, 'ADICIONOU_POKEDEX', `Adicionou '${name}' à sua Pokédex.`);
      res.status(201).json({ message: `${name} adicionado à Pokédex!` });
    } catch (error) { console.error("Erro ao adicionar na Pokédex:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.get('/mochila/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: itens } = await pool.query('SELECT * FROM mochila_itens WHERE user_id = $1 ORDER BY item_nome ASC', [userId]);
      res.status(200).json(itens);
    } catch (error) { console.error("Erro ao buscar itens da mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.post('/mochila/item', async (req, res) => {
    const { user_id, item_nome, quantidade } = req.body;
    if (!user_id || !item_nome || !quantidade) { return res.status(400).json({ message: 'Dados incompletos para adicionar o item.' }); }
    try {
      const { rows: itemExistenteRows } = await pool.query('SELECT * FROM mochila_itens WHERE user_id = $1 AND item_nome = $2', [user_id, item_nome]);
      let itemFinal;
      if (itemExistenteRows.length > 0) {
        const itemExistente = itemExistenteRows[0];
        const novaQuantidade = itemExistente.quantidade + parseInt(quantidade, 10);
        await pool.query('UPDATE mochila_itens SET quantidade = $1 WHERE id = $2', [novaQuantidade, itemExistente.id]);
        itemFinal = { ...itemExistente, quantidade: novaQuantidade };
        res.status(200).json(itemFinal);
      } else {
        const { rows } = await pool.query('INSERT INTO mochila_itens (user_id, item_nome, quantidade) VALUES ($1, $2, $3) RETURNING id', [user_id, item_nome, quantidade]);
        itemFinal = { id: rows[0].id, user_id, item_nome, quantidade };
        res.status(201).json(itemFinal);
      }
      await logAction(pool, user_id, 'ADICIONOU_ITEM', `Adicionou ${quantidade}x '${item_nome}' à mochila.`);
    } catch (error) { console.error("Erro ao adicionar item na mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.delete('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    try {
      const { rows: itemRows } = await pool.query('SELECT * FROM mochila_itens WHERE id = $1', [itemId]);
      const item = itemRows[0];
      if (!item) return res.status(404).json({ message: "Item não encontrado." });
      await pool.query('DELETE FROM mochila_itens WHERE id = $1', [itemId]);
      await logAction(pool, item.user_id, 'REMOVEU_ITEM', `Removeu ${item.quantidade}x '${item.item_nome}' da mochila.`);
      res.status(200).json({ message: 'Item removido com sucesso!' });
    } catch (error) { console.error("Erro ao remover item da mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  app.put('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    const { quantidade } = req.body;
    const novaQuantidade = parseInt(quantidade, 10);
    if (isNaN(novaQuantidade)) { return res.status(400).json({ message: 'Quantidade inválida.' }); }
    try {
      const { rows: itemRows } = await pool.query('SELECT * FROM mochila_itens WHERE id = $1', [itemId]);
      const item = itemRows[0];
      if (!item) return res.status(404).json({ message: "Item não encontrado." });
      if (novaQuantidade <= 0) {
        await pool.query('DELETE FROM mochila_itens WHERE id = $1', [itemId]);
        await logAction(pool, item.user_id, 'REMOVEU_ITEM', `Removeu o restante de '${item.item_nome}' da mochila.`);
        res.status(200).json({ message: 'Item removido da mochila.' });
      } else {
        await pool.query('UPDATE mochila_itens SET quantidade = $1 WHERE id = $2', [novaQuantidade, itemId]);
        const { rows: itemAtualizadoRows } = await pool.query('SELECT * FROM mochila_itens WHERE id = $1', [itemId]);
        const itemAtualizado = itemAtualizadoRows[0];
        await logAction(pool, item.user_id, 'EDITOU_ITEM', `Alterou a quantidade de '${item.item_nome}': ${item.quantidade} -> ${novaQuantidade}.`);
        res.status(200).json(itemAtualizado);
      }
    } catch (error) { console.error("Erro ao atualizar item na mochila:", error); res.status(500).json({ message: 'Erro interno no servidor.' }); }
  });

  // 4. Inicia o servidor
  app.listen(PORT, () => console.log(`🚀 Backend rodando em http://localhost:${PORT}`));
}

startServer();
