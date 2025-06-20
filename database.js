const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path'); // Importa o módulo 'path'
const fs = require('fs');     // Importa o módulo 'fs' (File System)

async function initializeDatabase() {
  try {
    // Define o caminho do banco de dados para o disco persistente da Render
    const dbPath = '/var/data/pokemon_manager.db';
    const dbDir = path.dirname(dbPath); // Pega o nome do diretório: /var/data

    // --- LÓGICA DE VERIFICAÇÃO E CRIAÇÃO DO DIRETÓRIO ---
    // Verifica se o diretório do banco de dados não existe
    if (!fs.existsSync(dbDir)) {
      console.log(`Diretório ${dbDir} não encontrado, criando...`);
      // Cria o diretório recursivamente. Isso garante que o caminho exista.
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = await open({
      filename: dbPath, // Usa a variável com o caminho
      driver: sqlite3.Database
    });

    console.log('Conectado ao banco de dados SQLite.');

    // --- CRIAÇÃO DAS TABELAS ---
    // Seu código para criar as tabelas (users, pokemons, etc.) continua aqui sem alterações
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        tipo_usuario TEXT NOT NULL,
        image_url TEXT
      )
    `);
    
    // ... cole aqui o restante dos seus comandos CREATE TABLE ...
    
    console.log("Tabelas verificadas/criadas.");

    // --- SEED DE DADOS INICIAIS ---
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