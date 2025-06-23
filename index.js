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

  // ------------------ ROTAS DA APLICAÇÃO ------------------

  // ... [todas as rotas de usuário, login, pokémon, já enviadas antes, permanecem aqui]
  // (Vou focar nas rotas que estavam faltando no seu backend!)

  // ------------------ MOCHILA ------------------

  app.get('/mochila/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: itens } = await pool.query('SELECT * FROM mochila_itens WHERE user_id = $1 ORDER BY item_nome ASC', [userId]);
      res.status(200).json(itens);
    } catch (error) { 
      console.error("Erro ao buscar itens da mochila:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/mochila/item', async (req, res) => {
    const { user_id, item_nome, quantidade } = req.body;
    if (!user_id || !item_nome || !quantidade) { 
      return res.status(400).json({ message: 'Dados incompletos para adicionar o item.' }); 
    }
    try {
      const { rows: itemExistenteRows } = await pool.query(
        'SELECT * FROM mochila_itens WHERE user_id = $1 AND item_nome = $2', 
        [user_id, item_nome]
      );
      let itemFinal;
      if (itemExistenteRows.length > 0) {
        const itemExistente = itemExistenteRows[0];
        const novaQuantidade = itemExistente.quantidade + parseInt(quantidade, 10);
        await pool.query('UPDATE mochila_itens SET quantidade = $1 WHERE id = $2', [novaQuantidade, itemExistente.id]);
        itemFinal = { ...itemExistente, quantidade: novaQuantidade };
        res.status(200).json(itemFinal);
      } else {
        const { rows } = await pool.query(
          'INSERT INTO mochila_itens (user_id, item_nome, quantidade) VALUES ($1, $2, $3) RETURNING id', 
          [user_id, item_nome, quantidade]
        );
        itemFinal = { id: rows[0].id, user_id, item_nome, quantidade };
        res.status(201).json(itemFinal);
      }
      await logAction(pool, user_id, 'ADICIONOU_ITEM', `Adicionou ${quantidade}x '${item_nome}' à mochila.`);
    } catch (error) { 
      console.error("Erro ao adicionar item na mochila:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' }); 
    }
  });

  app.put('/mochila/item/:itemId', async (req, res) => {
    const { itemId } = req.params;
    const { quantidade } = req.body;
    const novaQuantidade = parseInt(quantidade, 10);
    if (isNaN(novaQuantidade)) { 
      return res.status(400).json({ message: 'Quantidade inválida.' });
    }
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
    } catch (error) { 
      console.error("Erro ao atualizar item na mochila:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' }); 
    }
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
    } catch (error) { 
      console.error("Erro ao remover item da mochila:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // ------------------ POKEDEX ------------------

  app.get('/pokedex/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: entries } = await pool.query(
        'SELECT * FROM pokedex WHERE user_id = $1 ORDER BY id ASC', [userId]
      );
      res.status(200).json(entries);
    } catch (error) {
      console.error("Erro ao buscar dados da Pokédex:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.post('/pokedex', async (req, res) => {
    const { id, name, type, image_url, user_id } = req.body;
    try {
      if (!id || !name || !type || !image_url || !user_id) {
        return res.status(400).json({ message: 'Dados incompletos para adicionar à Pokédex.' });
      }
      await pool.query(
        `INSERT INTO pokedex (id, user_id, name, type, image_url)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id, user_id) DO NOTHING`,
        [id, user_id, name, type, image_url]
      );
      await logAction(pool, user_id, 'ADICIONOU_POKEDEX', `Adicionou '${name}' à sua Pokédex.`);
      res.status(201).json({ message: `${name} adicionado à Pokédex!` });
    } catch (error) {
      console.error("Erro ao adicionar na Pokédex:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // ------------------ DEPOSITO ------------------

  app.get('/deposito/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
      const { rows: pokemons } = await pool.query(
        "SELECT * FROM pokemons WHERE trainer_id = $1 AND status = 'D'", [userId]
      );
      res.status(200).json(pokemons);
    } catch (error) {
      console.error("Erro na rota /deposito/:userId:", error);
      res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  // [Garanta que as rotas de ficha de treinador (ficha), criação, edição, remoção de pokémon e demais já estejam no início do seu arquivo — essas são as principais que estavam faltando.]

  // -----------------------------------------------------------

  // Inicia o servidor
  app.listen(PORT, () => console.log(`🚀 Backend rodando em http://localhost:${PORT}`));
}

startServer();
