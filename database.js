const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path'); // Importa o módulo 'path'
const fs = require('fs');     // Importa o módulo 'fs' (File System)

async function initializeDatabase() {
  try {
    // Define o caminho do banco de dados para o disco persistente
    const dbPath = '/var/data/pokemon_manager.db';
    const dbDir = path.dirname(dbPath); // Pega o nome do diretório: /var/data

    // --- LÓGICA DE VERIFICAÇÃO E CRIAÇÃO DO DIRETÓRIO ---
    // Verifica se o diretório do banco de dados não existe
    if (!fs.existsSync(dbDir)) {
      console.log(`Diretório ${dbDir} não encontrado, criando...`);
      // Cria o diretório recursivamente
      fs.mkdirSync(dbDir, { recursive: true });
    }

    const db = await open({
      filename: dbPath, // Usa a variável com o caminho
      driver: sqlite3.Database
    });

    console.log('Conectado ao banco de dados SQLite.');

    // --- CRIAÇÃO DE TODAS AS TABELAS ---
    // ... (Seu código CREATE TABLE para users, pokemons, etc., continua aqui sem alterações) ...
    await db.exec(`CREATE TABLE IF NOT EXISTS users (...)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS pokemons (...)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS trainer_sheets (...)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS pokedex (...)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS mochila_itens (...)`);
    await db.exec(`CREATE TABLE IF NOT EXISTS audit_logs (...)`);

    console.log("Todas as tabelas foram verificadas/criadas.");

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