const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

async function initializeDatabase() {
  try {
    const db = await open({
      filename: './pokemon_manager.db',
      driver: sqlite3.Database
    });

    console.log('Conectado ao banco de dados SQLite.');

    // --- CRIAÇÃO DE TODAS AS TABELAS ---

    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        tipo_usuario TEXT NOT NULL,
        image_url TEXT
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS pokemons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        level INTEGER NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        max_hp INTEGER NOT NULL DEFAULT 10,
        current_hp INTEGER NOT NULL DEFAULT 10,
        image_url TEXT,
        trainer_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'U',
        FOREIGN KEY (trainer_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS trainer_sheets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL UNIQUE,
        nome TEXT, peso TEXT, idade TEXT, altura TEXT, cidade TEXT, regiao TEXT,
        xp TEXT, hp TEXT, level TEXT, vantagens_json TEXT, atributos_json TEXT, pericias_json TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    
    await db.exec(`
      CREATE TABLE IF NOT EXISTS pokedex (
        id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        image_url TEXT,
        PRIMARY KEY (id, user_id),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    await db.exec(`
      CREATE TABLE IF NOT EXISTS mochila_itens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        item_nome TEXT NOT NULL,
        quantidade INTEGER NOT NULL,
        UNIQUE(user_id, item_nome)
      )
    `);
    
    // Nova tabela para os logs de auditoria
    await db.exec(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        details TEXT
      )
    `);
    
    console.log("Todas as tabelas foram verificadas/criadas.");

    // Seed do usuário Master
    const masterUser = await db.get('SELECT * FROM users WHERE username = ?', ['master']);
    if (!masterUser) {
      await db.run( `INSERT INTO users (username, password, tipo_usuario, image_url) VALUES (?, ?, ?, ?)`, ['master', 'murilov', 'M', 'https://i.imgur.com/t9E4gE9.png']);
      console.log("Usuário 'master' criado com sucesso.");
    }

    return db;
  } catch (error) {
    console.error('Erro ao inicializar o banco de dados:', error);
    process.exit(1);
  }
}

module.exports = initializeDatabase;