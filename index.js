// ------------------- DEPENDÊNCIAS -------------------
// Certifique-se de que estas dependências estão no seu package.json:
// npm install express cors multer pg jsonwebtoken bcryptjs
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initializeDatabase = require('./database'); // Seu arquivo que retorna o pool de conexão do PostgreSQL

// ------------------- CONFIGURAÇÃO INICIAL -------------------
const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'SEGREDO_SUPER_SECRETO_PARA_DESENVOLVIMENTO';

// ------------------- FUNÇÕES AUXILIARES E MIDDLEWARES -------------------

/**
 * Função auxiliar para registrar logs de auditoria.
 * Agora usa a sintaxe do cliente 'pg'.
 */
async function logAction(dbClient, userId, action, details) {
  try {
    let username = 'Sistema';
    if (userId) {
      const { rows } = await dbClient.query('SELECT username FROM users WHERE id = $1', [userId]);
      if (rows.length > 0) username = rows[0].username;
    }
    await dbClient.query(
      'INSERT INTO audit_logs (user_id, username, action, details) VALUES ($1, $2, $3, $4)',
      [userId, username, action, details]
    );
  } catch (error) {
    console.error("Falha ao registrar ação de auditoria:", error);
  }
}

/**
 * Middleware de Autenticação para verificar o token JWT.
 */
function verificarToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Formato "Bearer TOKEN"

    if (!token) {
        return res.status(401).json({ message: 'Acesso negado. Nenhum token fornecido.' });
    }

    jwt.verify(token, JWT_SECRET, (err, userPayload) => {
        if (err) {
            return res.status(403).json({ message: 'Token inválido ou expirado.' });
        }
        req.user = userPayload; // Adiciona o payload do token (ex: { userId: 1, tipo_usuario: 'T' }) ao objeto req
        next();
    });
}


// ------------------- LÓGICA PRINCIPAL DO SERVIDOR -------------------
async function startServer() {
  const pool = await initializeDatabase(); // 'pool' é o objeto de conexão do PostgreSQL

  // Middlewares Globais
  app.use(cors());
  app.use(express.json());
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Configuração do Multer
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  });
  const upload = multer({ storage: storage });

  console.log('Pool de conexão com PostgreSQL inicializado. Configurando rotas...');

  // ================== ROTAS PÚBLICAS (NÃO EXIGEM AUTENTICAÇÃO) ==================

  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = rows[0];

        if (user && await bcrypt.compare(password, user.password)) {
            const tokenPayload = { userId: user.id, tipo_usuario: user.tipo_usuario };
            const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' });

            await logAction(pool, user.id, 'LOGIN', `Usuário '${user.username}' efetuou login.`);
            res.status(200).json({
                message: 'Login bem-sucedido!',
                token,
                user: { id: user.id, username: user.username, tipo_usuario: user.tipo_usuario }
            });
        } else {
            res.status(401).json({ message: 'Credenciais inválidas.' });
        }
    } catch (error) {
        console.error("Erro na rota /login:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/register', upload.single('imageFile'), async (req, res) => {
    const { username, password } = req.body;
    try {
        if (!username || !password) {
            return res.status(400).json({ message: 'Nome de usuário e senha são obrigatórios.' });
        }
        const { rows: existingRows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingRows.length > 0) {
            return res.status(409).json({ message: 'Este nome de usuário já está em uso.' });
        }

        let imageUrl = 'https://i.imgur.com/6MKOJ1G.png';
        if (req.file) {
            imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const { rows } = await pool.query(
            "INSERT INTO users (username, password, image_url, tipo_usuario) VALUES ($1, $2, $3, 'T') RETURNING id",
            [username, hashedPassword, imageUrl]
        );
        await logAction(pool, null, 'CADASTRO_TREINADOR', `O treinador '${username}' (ID: ${rows[0].id}) foi criado.`);
        res.status(201).json({ message: 'Treinador cadastrado com sucesso!', userId: rows[0].id });
    } catch (error) {
        console.error("Erro na rota /register:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // ================== ROTAS PROTEGIDAS (A PARTIR DAQUI, TODAS EXIGEM TOKEN) ==================
  app.use(verificarToken);

  // --- ROTAS DE USUÁRIOS / TREINADORES ---

  app.get('/users/all-trainers', async (req, res) => {
    if (req.user.tipo_usuario !== 'M') {
        return res.status(403).json({ message: 'Acesso negado. Apenas para mestres.' });
    }
    try {
        const { rows } = await pool.query("SELECT id, username, image_url FROM users WHERE tipo_usuario = 'T' ORDER BY username ASC");
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar todos os treinadores:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.get('/user/:id', async (req, res) => {
    const { id } = req.params;
    if (req.user.tipo_usuario !== 'M' && req.user.userId != id) {
        return res.status(403).json({ message: 'Você não tem permissão para ver este perfil.' });
    }
    try {
        const { rows } = await pool.query('SELECT id, username, image_url, tipo_usuario FROM users WHERE id = $1', [id]);
        if (rows.length > 0) {
            res.status(200).json(rows[0]);
        } else {
            res.status(404).json({ message: 'Usuário não encontrado.' });
        }
    } catch (error) {
        console.error("Erro na rota /user/:id:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.put('/user/:id', upload.single('imageFile'), async (req, res) => {
    const { id } = req.params;
    const { username, password } = req.body;

    if (req.user.tipo_usuario !== 'M' && req.user.userId != id) {
        return res.status(403).json({ message: 'Você não tem permissão para editar este perfil.' });
    }

    try {
        const { rows: currentRows } = await pool.query('SELECT username, image_url FROM users WHERE id = $1', [id]);
        const currentUser = currentRows[0];
        if (!currentUser) { return res.status(404).json({ message: 'Usuário não encontrado para atualizar.' }); }

        const updates = [];
        const params = [];
        let logDetails = [];

        if (username && username !== currentUser.username) {
            updates.push(`username = $${params.length + 1}`);
            params.push(username);
            logDetails.push(`Nome: '${currentUser.username}' -> '${username}'`);
        }
        if (password) {
            const salt = await bcrypt.genSalt(10);
            const hashedPassword = await bcrypt.hash(password, salt);
            updates.push(`password = $${params.length + 1}`);
            params.push(hashedPassword);
            logDetails.push('Senha alterada.');
        }
        if (req.file) {
            const newImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
            updates.push(`image_url = $${params.length + 1}`);
            params.push(newImageUrl);
            logDetails.push('Imagem alterada.');
            const defaultImage = 'https://i.imgur.com/6MKOJ1G.png';
            if (currentUser.image_url && currentUser.image_url !== defaultImage && currentUser.image_url.includes('/uploads/')) {
                const oldImageName = currentUser.image_url.split('/uploads/')[1];
                if (oldImageName) { fs.unlink(path.join(__dirname, 'uploads', oldImageName), (err) => { if (err) console.error("Erro ao deletar imagem antiga:", err); }); }
            }
        }
        if (updates.length === 0) {
            return res.status(400).json({ message: 'Nenhum dado fornecido para atualização.' });
        }

        params.push(id);
        const query = `UPDATE users SET ${updates.join(', ')} WHERE id = $${params.length} RETURNING id, username, image_url`;
        const { rows: updatedUserRows } = await pool.query(query, params);

        await logAction(pool, req.user.userId, 'EDITOU_TREINADOR', `Atualizou perfil de '${currentUser.username}' (ID: ${id}). Detalhes: ${logDetails.join('; ')}`);
        res.status(200).json({ message: 'Treinador atualizado com sucesso!', user: updatedUserRows[0] });
    } catch (error) {
        console.error("Erro na rota PUT /user/:id:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.delete('/user/:id', async (req, res) => {
    const { id } = req.params;
    if (req.user.tipo_usuario !== 'M') {
        return res.status(403).json({ message: 'Acesso negado. Apenas mestres podem deletar usuários.' });
    }
    
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { rows: userRows } = await client.query('SELECT username, image_url FROM users WHERE id = $1', [id]);
        const userToDelete = userRows[0];
        if (!userToDelete) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Usuário não encontrado.' });
        }

        await client.query('DELETE FROM pokemon_sheets WHERE pokemon_id IN (SELECT id FROM pokemons WHERE trainer_id = $1)', [id]);
        await client.query('DELETE FROM pokemons WHERE trainer_id = $1', [id]);
        await client.query('DELETE FROM trainer_sheets WHERE user_id = $1', [id]);
        await client.query('DELETE FROM pokedex WHERE user_id = $1', [id]);
        await client.query('DELETE FROM mochila_itens WHERE user_id = $1', [id]);
        await client.query('DELETE FROM users WHERE id = $1', [id]);

        const defaultImage = 'https://i.imgur.com/6MKOJ1G.png';
        if (userToDelete.image_url && userToDelete.image_url !== defaultImage && userToDelete.image_url.includes('/uploads/')) {
            const imageName = userToDelete.image_url.split('/uploads/')[1];
            if (imageName) { fs.unlink(path.join(__dirname, 'uploads', imageName), err => { if(err) console.error("Erro ao deletar imagem do usuário:", err); }); }
        }
        
        await logAction(client, req.user.userId, 'EXCLUSÃO_DE_TREINADOR', `O treinador '${userToDelete.username}' (ID: ${id}) foi excluído.`);
        await client.query('COMMIT');
        res.status(200).json({ message: 'Treinador e todos os seus dados foram excluídos com sucesso!' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro na rota DELETE /user/:id:", error);
        res.status(500).json({ message: 'Erro interno no servidor ao excluir treinador.' });
    } finally {
        client.release();
    }
  });

  // --- ROTAS DE POKÉMON ---

  app.get('/trainer/:trainerId/pokemons', async (req, res) => {
    const { trainerId } = req.params;
    if (req.user.tipo_usuario !== 'M' && req.user.userId != trainerId) {
        return res.status(403).json({ message: 'Não autorizado a ver os Pokémon deste treinador.' });
    }
    try {
        const { rows } = await pool.query("SELECT * FROM pokemons WHERE trainer_id = $1 AND status = 'U' ORDER BY id ASC", [trainerId]);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar Pokémon da equipe:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/pokemons', upload.single('imageFile'), async (req, res) => {
    const { trainer_id, name, type, level, image_url, ...stats } = req.body;
    if (req.user.tipo_usuario !== 'M' && req.user.userId != trainer_id) {
        return res.status(403).json({ message: 'Você não tem permissão para adicionar Pokémon a este treinador.' });
    }
    try {
        const { rows: team } = await pool.query('SELECT id FROM pokemons WHERE trainer_id = $1 AND status = $2', [trainer_id, "U"]);
        if (team.length >= 6) {
            return res.status(403).json({ message: 'Limite de 6 Pokémon por equipe atingido!' });
        }

        if (!name || !type || !trainer_id) {
            return res.status(400).json({ message: 'Nome, tipo e ID do treinador são obrigatórios.' });
        }

        let finalImageUrl = image_url || 'https://i.imgur.com/bTf0PCo.png';
        if (req.file) {
            finalImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        }
        
        const query = `
            INSERT INTO pokemons (name, type, level, xp, max_hp, current_hp, especial, especial_total, vigor, vigor_total, image_url, trainer_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'U') RETURNING *
        `;
        const values = [name, type, level || 1, stats.xp || 0, stats.max_hp || 10, stats.current_hp || 10, stats.especial || 10, stats.especial_total || 10, stats.vigor || 10, stats.vigor_total || 10, finalImageUrl, trainer_id];

        const { rows: newPokemonRows } = await pool.query(query, values);
        
        await logAction(pool, req.user.userId, 'ADICIONOU_POKEMON', `Adicionou '${name}' à equipe do treinador ID ${trainer_id}.`);
        res.status(201).json({ message: 'Pokémon cadastrado com sucesso!', pokemon: newPokemonRows[0] });
    } catch (error) {
        console.error("Erro ao criar Pokémon:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });
  
  app.put('/pokemon-stats/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    const stats = req.body;
    try {
        const { rows: pokemonRows } = await pool.query('SELECT * FROM pokemons WHERE id = $1', [pokemonId]);
        const pokemon = pokemonRows[0];
        if (!pokemon) return res.status(404).json({ message: 'Pokémon não encontrado.' });

        if (req.user.tipo_usuario !== 'M' && req.user.userId != pokemon.trainer_id) {
            return res.status(403).json({ message: 'Você não tem permissão para editar este Pokémon.' });
        }
        
        const updatedPokemon = { ...pokemon, ...stats };
        const query = `UPDATE pokemons SET level = $1, xp = $2, max_hp = $3, current_hp = $4, especial = $5, especial_total = $6, vigor = $7, vigor_total = $8 WHERE id = $9 RETURNING *`;
        const values = [updatedPokemon.level, updatedPokemon.xp, updatedPokemon.max_hp, updatedPokemon.current_hp, updatedPokemon.especial, updatedPokemon.especial_total, updatedPokemon.vigor, updatedPokemon.vigor_total, pokemonId];
        
        const { rows } = await pool.query(query, values);

        await logAction(pool, req.user.userId, 'EDITOU_POKEMON_STATS', `Stats de '${pokemon.name}' (ID: ${pokemonId}) atualizados.`);
        res.status(200).json({ message: 'Stats do Pokémon atualizados!', pokemon: rows[0] });
    } catch (error) {
        console.error("Erro ao atualizar stats do Pokémon:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.delete('/pokemon/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT name, trainer_id, image_url FROM pokemons WHERE id = $1', [pokemonId]);
        const pokemonToDelete = rows[0];
        if (!pokemonToDelete) {
             await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Pokémon não encontrado.' });
        }
        if (req.user.tipo_usuario !== 'M' && req.user.userId != pokemonToDelete.trainer_id) {
            await client.query('ROLLBACK');
            return res.status(403).json({ message: 'Você não tem permissão para liberar este Pokémon.' });
        }
        
        await client.query('DELETE FROM pokemon_sheets WHERE pokemon_id = $1', [pokemonId]);
        await client.query('DELETE FROM pokemons WHERE id = $1', [pokemonId]);

        if (pokemonToDelete.image_url && pokemonToDelete.image_url.includes('/uploads/')) {
            const oldImageName = pokemonToDelete.image_url.split('/uploads/')[1];
            if (oldImageName) { fs.unlink(path.join(__dirname, 'uploads', oldImageName), (err) => { if (err) console.error("Erro ao deletar a imagem do pokémon:", err); }); }
        }
        
        await logAction(client, pokemonToDelete.trainer_id, 'LIBEROU_POKEMON', `O pokémon '${pokemonToDelete.name}' foi liberado.`);
        await client.query('COMMIT');
        res.status(200).json({ message: 'Pokémon liberado com sucesso!' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Erro ao liberar Pokémon:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    } finally {
        client.release();
    }
  });


  // --- ROTAS DO DEPÓSITO DE POKÉMON (BOX) ---
  
  app.get('/deposito', async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query("SELECT * FROM pokemons WHERE trainer_id = $1 AND status = 'D' ORDER BY name ASC", [userId]);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar pokémons no depósito:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.put('/pokemon/:pokemonId/deposit', async (req, res) => {
    const { pokemonId } = req.params;
    try {
        const { rows } = await pool.query('SELECT name, trainer_id FROM pokemons WHERE id = $1', [pokemonId]);
        const pokemon = rows[0];
        if (!pokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
        if (req.user.tipo_usuario !== 'M' && req.user.userId != pokemon.trainer_id) {
            return res.status(403).json({ message: 'Ação não permitida.' });
        }
        
        await pool.query("UPDATE pokemons SET status = 'D' WHERE id = $1", [pokemonId]);
        await logAction(pool, pokemon.trainer_id, 'DEPOSITOU_POKEMON', `O pokémon '${pokemon.name}' foi depositado.`);
        res.status(200).json({ message: 'Pokémon depositado com sucesso!' });
    } catch (error) {
        console.error("Erro ao depositar Pokémon:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.put('/pokemon/:pokemonId/withdraw', async (req, res) => {
    const { pokemonId } = req.params;
    try {
        const { rows: pokemonRows } = await pool.query('SELECT name, trainer_id FROM pokemons WHERE id = $1', [pokemonId]);
        const pokemon = pokemonRows[0];
        if (!pokemon) { return res.status(404).json({ message: 'Pokémon não encontrado.' }); }
        if (req.user.tipo_usuario !== 'M' && req.user.userId != pokemon.trainer_id) {
            return res.status(403).json({ message: 'Ação não permitida.' });
        }

        const { rows: teamRows } = await pool.query("SELECT id FROM pokemons WHERE trainer_id = $1 AND status = 'U'", [pokemon.trainer_id]);
        if (teamRows.length >= 6) {
            return res.status(403).json({ message: 'A equipe já está cheia (limite de 6 Pokémon)!' });
        }

        await pool.query("UPDATE pokemons SET status = 'U' WHERE id = $1", [pokemonId]);
        await logAction(pool, pokemon.trainer_id, 'RETIROU_POKEMON', `O pokémon '${pokemon.name}' foi retirado do depósito.`);
        res.status(200).json({ message: 'Pokémon retirado do depósito!' });
    } catch (error) {
        console.error("Erro ao retirar Pokémon:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // --- ROTAS DA FICHA DO TREINADOR ---

  app.get('/ficha', async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query('SELECT * FROM trainer_sheets WHERE user_id = $1', [userId]);
        if (rows.length > 0) {
            const sheet = rows[0];
            // JSON.parse para converter as strings do banco em objetos/arrays
            sheet.vantagens = JSON.parse(sheet.vantagens_json || '[]');
            sheet.atributos = JSON.parse(sheet.atributos_json || '{}');
            sheet.pericias = JSON.parse(sheet.pericias_json || '{}');
            res.status(200).json(sheet);
        } else {
            res.status(404).json({ message: 'Nenhuma ficha encontrada para este treinador.' });
        }
    } catch (error) {
        console.error("Erro ao buscar ficha do treinador:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.put('/ficha', async (req, res) => {
    const userId = req.user.userId;
    const dados = req.body;
    try {
        const query = `
            INSERT INTO trainer_sheets (user_id, nome, peso, idade, altura, cidade, regiao, xp, hp, level, vantagens_json, atributos_json, pericias_json)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT(user_id) DO UPDATE SET
                nome=excluded.nome, peso=excluded.peso, idade=excluded.idade, altura=excluded.altura, cidade=excluded.cidade,
                regiao=excluded.regiao, xp=excluded.xp, hp=excluded.hp, level=excluded.level, vantagens_json=excluded.vantagens_json,
                atributos_json=excluded.atributos_json, pericias_json=excluded.pericias_json
        `;
        const values = [
            userId, dados.nome, dados.peso, dados.idade, dados.altura, dados.cidade, dados.regiao, dados.xp, dados.hp, dados.level,
            JSON.stringify(dados.vantagens || []),
            JSON.stringify(dados.atributos || {}),
            JSON.stringify(dados.pericias || {})
        ];
        
        await pool.query(query, values);
        await logAction(pool, userId, 'SALVOU_FICHA_TREINADOR', `A ficha do treinador '${dados.nome}' foi salva.`);
        res.status(200).json({ message: 'Ficha salva com sucesso!' });
    } catch (error) {
        console.error("Erro ao salvar a ficha:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // --- ROTAS DA POKEDEX ---

  app.get('/pokedex', async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query('SELECT * FROM pokedex WHERE user_id = $1 ORDER BY id ASC', [userId]);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar dados da Pokédex:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/pokedex', async (req, res) => {
    const { id, name, type, image_url } = req.body;
    const userId = req.user.userId;
    try {
        if (!id || !name || !type) {
            return res.status(400).json({ message: 'Dados incompletos para adicionar à Pokédex.' });
        }
        const { rowCount } = await pool.query(
            `INSERT INTO pokedex (id, user_id, name, type, image_url)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id, user_id) DO NOTHING`,
            [id, userId, name, type, image_url || null]
        );
        
        if (rowCount > 0) {
             await logAction(pool, userId, 'ADICIONOU_POKEDEX', `Adicionou '${name}' à sua Pokédex.`);
             res.status(201).json({ message: `${name} adicionado à Pokédex!` });
        } else {
             res.status(200).json({ message: `${name} já estava na sua Pokédex.` });
        }
    } catch (error) {
        console.error("Erro ao adicionar na Pokédex:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // --- ROTAS DA MOCHILA ---

  app.get('/mochila', async (req, res) => {
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query('SELECT * FROM mochila_itens WHERE user_id = $1 ORDER BY item_nome ASC', [userId]);
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar itens da mochila:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/mochila/item', async (req, res) => {
      const { item_nome, quantidade } = req.body;
      const userId = req.user.userId;
      const qtd = parseInt(quantidade, 10);

      if (!item_nome || !qtd || qtd <= 0) {
          return res.status(400).json({ message: 'Nome do item e quantidade válida são obrigatórios.' });
      }

      const client = await pool.connect();
      try {
          await client.query('BEGIN');
          const { rows: itemExistenteRows } = await client.query('SELECT * FROM mochila_itens WHERE user_id = $1 AND item_nome = $2', [userId, item_nome]);
          
          let itemFinal;
          if (itemExistenteRows.length > 0) {
              const itemExistente = itemExistenteRows[0];
              const novaQuantidade = itemExistente.quantidade + qtd;
              const { rows } = await client.query('UPDATE mochila_itens SET quantidade = $1 WHERE id = $2 RETURNING *', [novaQuantidade, itemExistente.id]);
              itemFinal = rows[0];
          } else {
              const { rows } = await client.query('INSERT INTO mochila_itens (user_id, item_nome, quantidade) VALUES ($1, $2, $3) RETURNING *', [userId, item_nome, qtd]);
              itemFinal = rows[0];
          }
          
          await logAction(client, userId, 'ADICIONOU_ITEM', `Adicionou ${qtd}x '${item_nome}' à mochila.`);
          await client.query('COMMIT');
          res.status(201).json(itemFinal);
      } catch (error) {
          await client.query('ROLLBACK');
          console.error("Erro ao adicionar item na mochila:", error);
          res.status(500).json({ message: 'Erro interno no servidor.' });
      } finally {
          client.release();
      }
  });

  app.put('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    const { quantidade } = req.body;
    const userId = req.user.userId;
    const novaQuantidade = parseInt(quantidade, 10);

    if (isNaN(novaQuantidade) || novaQuantidade < 0) {
        return res.status(400).json({ message: 'Quantidade inválida.' });
    }
    try {
        const { rows } = await pool.query('SELECT * FROM mochila_itens WHERE id = $1 AND user_id = $2', [itemId, userId]);
        const item = rows[0];
        if (!item) {
            return res.status(404).json({ message: "Item não encontrado na sua mochila." });
        }

        if (novaQuantidade === 0) {
            await pool.query('DELETE FROM mochila_itens WHERE id = $1', [itemId]);
            await logAction(pool, userId, 'REMOVEU_ITEM', `Removeu o restante de '${item.item_nome}' da mochila.`);
            res.status(200).json({ message: 'Item removido da mochila.' });
        } else {
            const { rows: updatedRows } = await pool.query('UPDATE mochila_itens SET quantidade = $1 WHERE id = $2 RETURNING *', [novaQuantidade, itemId]);
            await logAction(pool, userId, 'EDITOU_ITEM', `Alterou a quantidade de '${item.item_nome}': ${item.quantidade} -> ${novaQuantidade}.`);
            res.status(200).json(updatedRows[0]);
        }
    } catch (error) {
        console.error("Erro ao atualizar item na mochila:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.delete('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    const userId = req.user.userId;
    try {
        const { rows } = await pool.query('SELECT * FROM mochila_itens WHERE id = $1 AND user_id = $2', [itemId, userId]);
        const item = rows[0];
        if (!item) {
            return res.status(404).json({ message: "Item não encontrado." });
        }
        await pool.query('DELETE FROM mochila_itens WHERE id = $1', [itemId]);
        await logAction(pool, userId, 'REMOVEU_ITEM', `Removeu ${item.quantidade}x '${item.item_nome}' da mochila.`);
        res.status(200).json({ message: 'Item removido com sucesso!' });
    } catch (error) {
        console.error("Erro ao remover item da mochila:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // --- ROTA DE AUDITORIA (APENAS PARA MESTRES) ---
  app.get('/auditoria', async (req, res) => {
    if (req.user.tipo_usuario !== 'M') {
        return res.status(403).json({ message: 'Acesso negado. Apenas mestres podem ver os logs.' });
    }
    try {
        const { rows } = await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 200');
        res.status(200).json(rows);
    } catch (error) {
        console.error("Erro ao buscar logs de auditoria:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // ------------------- INICIA O SERVIDOR -------------------
  app.listen(PORT, () => console.log(`🚀 Backend rodando em http://localhost:${PORT}`));
}

// Chama a função principal para iniciar o servidor
startServer();

