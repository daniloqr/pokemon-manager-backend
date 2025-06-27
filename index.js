// index.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const initializeDatabase = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

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

async function startServer() {
  const pool = await initializeDatabase();

  app.use(cors());
  app.use(express.json());
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  });
  const upload = multer({ storage: storage });

  console.log('Pool de conexão com PostgreSQL inicializado. Configurando rotas...');

  // --- ROTAS DE LOGIN E REGISTRO ---
  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const { rows } = await pool.query('SELECT id, username, tipo_usuario FROM users WHERE username = $1 AND password = $2', [username, password]);
        const user = rows[0];
        if (user) {
            await logAction(pool, user.id, 'LOGIN', `Usuário '${user.username}' efetuou login.`);
            res.status(200).json({ message: 'Login bem-sucedido!', user });
        } else {
            res.status(401).json({ message: 'Credenciais inválidas.' });
        }
    } catch (error) {
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/users/register', upload.single('imageFile'), async (req, res) => {
    const { username, password } = req.body;
    try {
        const { rows: existingRows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (existingRows.length > 0) { return res.status(409).json({ message: 'Este nome de usuário já está em uso.' }); }
        let imageUrl = 'https://i.imgur.com/6MKOJ1G.png';
        if (req.file) { imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`; }
        const { rows } = await pool.query("INSERT INTO users (username, password, image_url, tipo_usuario) VALUES ($1, $2, $3, 'T') RETURNING id", [username, password, imageUrl]);
        await logAction(pool, 1, 'CADASTRO_TREINADOR', `O treinador '${username}' (ID: ${rows[0].id}) foi criado.`);
        res.status(201).json({ message: 'Treinador cadastrado com sucesso!', userId: rows[0].id });
    } catch (error) {
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // --- ROTA DE EXCLUSÃO DE POKÉMON ---
  app.delete('/pokemon/:pokemonId', async (req, res) => {
    const { pokemonId } = req.params;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows } = await client.query('SELECT name, trainer_id, image_url FROM pokemons WHERE id = $1', [pokemonId]);
        const pokemonToDelete = rows[0];
        if (!pokemonToDelete) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Pokémon não encontrado para exclusão.' });
        }
        await client.query('DELETE FROM pokemon_sheets WHERE pokemon_id = $1', [pokemonId]);
        await client.query('DELETE FROM pokemons WHERE id = $1', [pokemonId]);
        if (pokemonToDelete.image_url && pokemonToDelete.image_url.includes('/uploads/')) {
            const oldImageName = pokemonToDelete.image_url.split('/uploads/')[1];
            if (oldImageName) { fs.unlink(path.join(__dirname, 'uploads', oldImageName), (err) => { if (err) console.error("Erro ao deletar a imagem do pokémon:", err); }); }
        }
        await logAction(client, pokemonToDelete.trainer_id, 'LIBEROU_POKEMON', `O pokémon '${pokemonToDelete.name}' foi liberado.`);
        await client.query('COMMIT');
        res.status(200).json({ message: 'Pokémon excluído com sucesso!', deletedPokemonId: pokemonId });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ message: 'Erro interno no servidor.' });
    } finally {
        client.release();
    }
  });

  // ... (TODAS AS OUTRAS ROTAS QUE JÁ TINHAMOS COLOCADO ANTES ESTÃO AQUI)
  // ... (Ficha, Mochila, Pokédex, etc.)

  app.listen(PORT, () => console.log(`🚀 Backend rodando em http://localhost:${PORT}`));
}

startServer();
