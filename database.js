// database.js
const { Pool } = require('pg');

// Configura a conexão usando a variável de ambiente fornecida pela plataforma de deploy
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/**
 * Inicializa o banco de dados, criando as tabelas se elas não existirem.
 */
async function initializeDatabase() {
  const client = await pool.connect(); // Pega um cliente de conexão para as operações
  try {
    // Tabela de usuários
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        tipo_usuario TEXT NOT NULL,
        image_url TEXT
      );
    `);

    // Tabela de pokémons
    await client.query(`
      CREATE TABLE IF NOT EXISTS pokemons (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        max_hp INTEGER NOT NULL DEFAULT 10,
        current_hp INTEGER NOT NULL DEFAULT 10,
        especial INTEGER NOT NULL DEFAULT 10,
        especial_total INTEGER NOT NULL DEFAULT 10,
        vigor INTEGER NOT NULL DEFAULT 10,
        vigor_total INTEGER NOT NULL DEFAULT 10,
        image_url TEXT,
        trainer_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'U', /* U = In Use, D = Deposited */
        FOREIGN KEY (trainer_id) REFERENCES users (id) ON DELETE CASCADE
      );
    `);
    
    // Tabela de fichas dos treinadores
    await client.query(`
      CREATE TABLE IF NOT EXISTS trainer_sheets (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL UNIQUE,
        nome TEXT, peso TEXT, idade TEXT, altura TEXT, cidade TEXT, regiao TEXT,
        xp TEXT, hp TEXT, level TEXT, vantagens_json TEXT, atributos_json TEXT, pericias_json TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
    `);
    
    // Tabela da Pokédex
    await client.query(`
      CREATE TABLE IF NOT EXISTS pokedex (
        id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        image_url TEXT,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      );
    `);

    // Tabela da mochila de itens
    await client.query(`
      CREATE TABLE IF NOT EXISTS mochila_itens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL,
        item_nome TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(user_id, item_nome)
      );
    `);

    // Tabela de logs de auditoria
    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        details TEXT
      );
    `);
    
    // Tabela de fichas dos pokémons
    await client.query(`
      CREATE TABLE IF NOT EXISTS pokemon_sheets (
        id SERIAL PRIMARY KEY,
        pokemon_id INTEGER NOT NULL UNIQUE,
        FOREIGN KEY (pokemon_id) REFERENCES pokemons(id) ON DELETE CASCADE
      );
    `);

    // Seed do usuário master
    const { rows: masterUserRows } = await client.query('SELECT * FROM users WHERE username = $1', ['master']);
    if (masterUserRows.length === 0) {
      await client.query(
        `INSERT INTO users (username, password, tipo_usuario, image_url) VALUES ($1, $2, $3, $4)`,
        ['master', 'murilov', 'M', 'https://i.imgur.com/t9E4gE9.png']
      );
      console.log("Usuário 'master' criado com sucesso.");
    }

    console.log("Banco de dados PostgreSQL inicializado e tabelas verificadas com sucesso.");
    return pool; // Retorna o pool para ser usado no index.js
  } catch (error) {
    console.error('Erro fatal ao inicializar o banco de dados:', error);
    process.exit(1);
  } finally {
    client.release(); // Libera o cliente de volta para o pool
  }
}

module.exports = initializeDatabase;
