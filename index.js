
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const initializeDatabase = require('./database'); // Seu arquivo de conexão com o DB

// ------------------- CONFIGURAÇÃO INICIAL -------------------
const app = express();
const PORT = process.env.PORT || 3001;
// É uma boa prática usar variáveis de ambiente para o segredo do JWT.
// Em desenvolvimento, podemos usar um valor padrão.
const JWT_SECRET = process.env.JWT_SECRET || 'SEGREDO_SUPER_SECRETO_PARA_DESENVOLVIMENTO';

// ------------------- FUNÇÕES AUXILIARES E MIDDLEWARES -------------------

/**
 * Função auxiliar para registrar logs de auditoria.
 * @param {object} dbClient - O cliente ou pool de conexão do banco de dados.
 * @param {number|null} userId - O ID do usuário que realiza a ação.
 * @param {string} action - O tipo de ação (ex: 'LOGIN', 'CRIOU_POKEMON').
 * @param {string} details - Uma descrição detalhada da ação.
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
 * Middleware de Autenticação.
 * Verifica a validade do token JWT enviado no cabeçalho da requisição.
 * Se o token for válido, adiciona os dados do usuário (payload) ao objeto `req.user`.
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
        req.user = userPayload; // Adiciona o payload do token (ex: { userId: 1, tipo_usuario: 'T' })
        next();
    });
}


// ------------------- LÓGICA PRINCIPAL DO SERVIDOR -------------------
async function startServer() {
  const pool = await initializeDatabase();

  // Middlewares Globais
  app.use(cors());
  app.use(express.json());
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Configuração do Multer para upload de arquivos
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
  });
  const upload = multer({ storage: storage });

  // ================== ROTAS PÚBLICAS (NÃO EXIGEM AUTENTICAÇÃO) ==================

  /**
   * Rota de Login.
   * Valida as credenciais e retorna um token JWT se o login for bem-sucedido.
   */
  app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Nome de usuário e senha são obrigatórios.' });
    }
    try {
        const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        const user = rows[0];

        if (user && await bcrypt.compare(password, user.password)) {
            // Senha correta, gerar token JWT
            const tokenPayload = { userId: user.id, tipo_usuario: user.tipo_usuario };
            const token = jwt.sign(tokenPayload, JWT_SECRET, { expiresIn: '8h' }); // Token expira em 8 horas

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

  /**
   * Rota de Registro de novo usuário (treinador).
   * A senha é armazenada com hash.
   */
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


  // ================== ROTAS PROTEGIDAS (EXIGEM AUTENTICAÇÃO) ==================

  // A partir daqui, todas as rotas usarão o middleware 'verificarToken'
  app.use(verificarToken);

  // --- ROTAS DE USUÁRIOS / TREINADORES ---

  app.get('/users/all', async (req, res) => {
    // Apenas Mestres podem ver todos os treinadores
    if (req.user.tipo_usuario !== 'M') {
        return res.status(403).json({ message: 'Acesso negado. Apenas para mestres.' });
    }
    try {
        const { rows: trainers } = await pool.query("SELECT id, username, image_url FROM users WHERE tipo_usuario = 'T' ORDER BY username ASC");
        res.status(200).json(trainers);
    } catch (error) {
        console.error("Erro ao buscar todos os treinadores:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });

  app.get('/user/:id', async (req, res) => {
    const { id } = req.params;
    // Um mestre pode ver qualquer perfil, um treinador só pode ver o seu próprio.
    if (req.user.tipo_usuario !== 'M' && req.user.userId != id) {
        return res.status(403).json({ message: 'Você não tem permissão para ver este perfil.' });
    }
    try {
        const { rows } = await pool.query('SELECT id, username, image_url, tipo_usuario FROM users WHERE id = $1', [id]);
        if (rows[0]) {
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

        // Apenas um Mestre ou o próprio usuário pode editar o perfil.
        if (req.user.tipo_usuario !== 'M' && req.user.userId != id) {
            return res.status(403).json({ message: 'Você não tem permissão para editar este perfil.' });
        }

        try {
            const { rows: currentRows } = await pool.query('SELECT username, image_url FROM users WHERE id = $1', [id]);
            const currentUser = currentRows[0];
            if (!currentUser) { return res.status(404).json({ message: 'Usuário não encontrado.' }); }

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
                // Lógica para deletar imagem antiga
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
        // Apenas Mestres podem deletar usuários
        if (req.user.tipo_usuario !== 'M') {
            return res.status(403).json({ message: 'Acesso negado. Apenas mestres podem deletar usuários.' });
        }
        
        // Usar transação para garantir que todos os dados sejam removidos atomicamente
        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            const { rows: userRows } = await client.query('SELECT username, image_url FROM users WHERE id = $1', [id]);
            const userToDelete = userRows[0];
            if (!userToDelete) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Usuário não encontrado.' });
            }

            // Deletar dados relacionados em outras tabelas
            await client.query('DELETE FROM pokemon_sheets WHERE pokemon_id IN (SELECT id FROM pokemons WHERE trainer_id = $1)', [id]);
            await client.query('DELETE FROM pokemons WHERE trainer_id = $1', [id]);
            await client.query('DELETE FROM trainer_sheets WHERE user_id = $1', [id]);
            await client.query('DELETE FROM pokedex WHERE user_id = $1', [id]);
            await client.query('DELETE FROM mochila_itens WHERE user_id = $1', [id]);
            await client.query('DELETE FROM users WHERE id = $1', [id]);

            // Deletar arquivo de imagem se existir
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
    // Permissão: Mestre pode ver os pokemons de qualquer um, treinador só os seus.
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
    const { trainer_id } = req.body;
    // Permissão: Mestre pode adicionar pokémon para qualquer um, treinador só para si mesmo.
     if (req.user.tipo_usuario !== 'M' && req.user.userId != trainer_id) {
        return res.status(403).json({ message: 'Você não tem permissão para adicionar Pokémon a este treinador.' });
    }
    try {
        const team = await pool.query('SELECT id FROM pokemons WHERE trainer_id = $1 AND status = $2', [trainer_id, "U"]);
        if (team.rows.length >= 6) {
            return res.status(403).json({ message: 'Limite de 6 Pokémon por equipe atingido!' });
        }

        const { name, type, level, xp, max_hp, current_hp, especial, especial_total, vigor, vigor_total, image_url } = req.body;
        if (!name || !type || !trainer_id) {
            return res.status(400).json({ message: 'Nome, tipo e ID do treinador são obrigatórios.' });
        }

        let finalImageUrl = image_url || 'https://i.imgur.com/bTf0PCo.png';
        if (req.file) {
            finalImageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
        }
        
        const { rows } = await pool.query(
            `INSERT INTO pokemons (name, type, level, xp, max_hp, current_hp, especial, especial_total, vigor, vigor_total, image_url, trainer_id, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'U') RETURNING *`,
            [name, type, level || 1, xp || 0, max_hp || 10, current_hp || 10, especial || 10, especial_total || 10, vigor || 10, vigor_total || 10, finalImageUrl, trainer_id]
        );
        
        await logAction(pool, req.user.userId, 'ADICIONOU_POKEMON', `Adicionou '${name}' à equipe do treinador ID ${trainer_id}.`);
        res.status(201).json({ message: 'Pokémon cadastrado com sucesso!', pokemon: rows[0] });
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

            // Permissão: Mestre pode editar qualquer pokémon, treinador só os seus.
            if (req.user.tipo_usuario !== 'M' && req.user.userId != pokemon.trainer_id) {
                return res.status(403).json({ message: 'Você não tem permissão para editar este Pokémon.' });
            }

            const updatedPokemon = { ...pokemon, ...stats };

            const { rows } = await pool.query(
                `UPDATE pokemons SET level = $1, xp = $2, max_hp = $3, current_hp = $4, especial = $5, especial_total = $6, vigor = $7, vigor_total = $8
                 WHERE id = $9 RETURNING *`,
                [updatedPokemon.level, updatedPokemon.xp, updatedPokemon.max_hp, updatedPokemon.current_hp, updatedPokemon.especial, updatedPokemon.especial_total, updatedPokemon.vigor, updatedPokemon.vigor_total, pokemonId]
            );

            await logAction(pool, req.user.userId, 'EDITOU_POKEMON_STATS', `Stats de '${pokemon.name}' (ID: ${pokemonId}) atualizados.`);
            res.status(200).json({ message: 'Stats do Pokémon atualizados!', pokemon: rows[0] });

        } catch (error) {
            console.error("Erro ao atualizar stats do Pokémon:", error);
            res.status(500).json({ message: 'Erro interno no servidor.' });
        }
    });

  // --- ROTAS DA MOCHILA ---

  app.get('/mochila', async (req, res) => {
    const userId = req.user.userId; // Pega o ID do usuário logado a partir do token
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

          const { rows: itemExistenteRows } = await client.query(
              'SELECT * FROM mochila_itens WHERE user_id = $1 AND item_nome = $2', [userId, item_nome]
          );
          
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
            await logAction(pool, userId, 'REMOVEU_ITEM_COMPLETO', `Removeu o restante de '${item.item_nome}' da mochila.`);
            res.status(200).json({ message: 'Item removido da mochila.' });
        } else {
            const { rows: updatedRows } = await pool.query('UPDATE mochila_itens SET quantidade = $1 WHERE id = $2 RETURNING *', [novaQuantidade, itemId]);
            await logAction(pool, userId, 'EDITOU_ITEM_QTD', `Alterou a quantidade de '${item.item_nome}': ${item.quantidade} -> ${novaQuantidade}.`);
            res.status(200).json(updatedRows[0]);
        }
    } catch (error) {
        console.error("Erro ao atualizar item na mochila:", error);
        res.status(500).json({ message: 'Erro interno no servidor.' });
    }
  });


  // --- ROTAS DA POKÉDEX ---

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
        // ON CONFLICT previne entradas duplicadas para o mesmo usuário e pokémon
        const { rowCount } = await pool.query(
            `INSERT INTO pokedex (id, user_id, name, type, image_url)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (id, user_id) DO NOTHING`,
            [id, userId, name, type, image_url]
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

  // --- ROTAS DE LOGS (APENAS PARA MESTRES) ---
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
