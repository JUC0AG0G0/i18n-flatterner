import fs from 'fs';
import path from 'path';
import readline from 'readline';

// Charge la config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf-8'));

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askQuestion = (query) => new Promise(resolve => rl.question(query, resolve));

function getAllFiles(dirPath, arrayOfFiles = []) {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  
  const files = fs.readdirSync(dirPath);
  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (!file.startsWith('.') && file !== 'node_modules') {
        getAllFiles(fullPath, arrayOfFiles);
      }
    } else {
      if (config.fileExtensions.includes(path.extname(file))) {
        arrayOfFiles.push(fullPath);
      }
    }
  });

  return arrayOfFiles;
}

function extractKeys(obj, prefix = '', depth = 1) {
  let keys = [];
  for (const k in obj) {
    if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
      const currentPrefix = prefix ? `${prefix}.${k}` : k;
      keys.push(...extractKeys(obj[k], currentPrefix, depth + 1));
    } else {
      keys.push({ path: prefix ? `${prefix}.${k}` : k, depth: depth });
    }
  }
  return keys;
}

function suggestNewKey(oldKey) {
  const parts = oldKey.split('.');
  if (parts.length <= 2) return oldKey;

  const level1 = parts[0];
  const lastKey = parts[parts.length - 1];
  const intermediateKeys = parts.slice(1, -1).reverse();

  const formattedIntermediates = intermediateKeys
    .map(key => key.charAt(0).toUpperCase() + key.slice(1))
    .join('');

  return `${level1}.${lastKey}${formattedIntermediates}`;
}

function updateJsonObject(obj, oldPath, newPath) {
  const oldParts = oldPath.split('.');
  const newParts = newPath.split('.');

  let current = obj;
  for (let i = 0; i < oldParts.length - 1; i++) {
    current = current?.[oldParts[i]];
  }
  
  if (!current || !(oldParts[oldParts.length - 1] in current)) return false;
  
  const value = current[oldParts[oldParts.length - 1]];
  delete current[oldParts[oldParts.length - 1]];

  cleanEmptyParents(obj, oldParts);

  let target = obj;
  for (let i = 0; i < newParts.length - 1; i++) {
    if (!target[newParts[i]] || typeof target[newParts[i]] !== 'object') {
      target[newParts[i]] = {};
    }
    target = target[newParts[i]];
  }
  target[newParts[newParts.length - 1]] = value;
  return true;
}

function cleanEmptyParents(obj, pathParts) {
  if (pathParts.length <= 1) return;
  const parentPath = pathParts.slice(0, -1);
  let current = obj;
  for (let i = 0; i < parentPath.length - 1; i++) {
    current = current?.[parentPath[i]];
    if (!current) return;
  }
  const last = parentPath[parentPath.length - 1];
  if (current[last] && Object.keys(current[last]).length === 0) {
    delete current[last];
    cleanEmptyParents(obj, parentPath);
  }
}

function updateQuarantinedKeys(jsonObj, oldKey, newKey) {
  if (!jsonObj.quarantinedKeys) return false;

  if (jsonObj.quarantinedKeys[oldKey]) {
    jsonObj.quarantinedKeys[newKey] = jsonObj.quarantinedKeys[oldKey];
    delete jsonObj.quarantinedKeys[oldKey];
    return true;
  }
  return false;
}

// 🆕 NOUVELLE FONCTION : Trie récursivement toutes les clés d'un objet par ordre alphabétique
function sortObjectKeys(obj) {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return obj;
  }
  
  const sortedKeys = Object.keys(obj).sort();
  const result = {};
  
  for (const key of sortedKeys) {
    result[key] = sortObjectKeys(obj[key]);
  }
  
  return result;
}

async function main() {
  console.log("🚀 Analyse des fichiers de traduction et du code source...");

  const translations = config.translationFiles.map(filePath => {
    if (!fs.existsSync(filePath)) return null;
    return { path: filePath, content: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
  }).filter(t => t !== null);

  const primaryJson = translations[0].content;
  const allKeys = extractKeys(primaryJson);

  const keysToProcess = allKeys.filter(k => {
    const rootKey = k.path.split('.')[0];
    return k.depth > config.maxDepthAllowed && !config.ignoredParentKeys.includes(rootKey);
  });

  const groups = {};
  keysToProcess.forEach(k => {
    const parentPath = k.path.split('.').slice(0, -1).join('.');
    if (!groups[parentPath]) groups[parentPath] = [];
    groups[parentPath].push(k);
  });

  const codeFiles = getAllFiles(config.projectRoot);
  let totalCodeFilesUpdated = 0;

  for (const [parentPath, keys] of Object.entries(groups)) {
    console.log(`\n======================================================`);
    console.log(`📂 Groupe : \x1b[36m${parentPath}\x1b[0m (${keys.length} clés)`);
    console.log(`======================================================`);
    
    const groupReplacements = [];

    keys.forEach(k => {
      const suggested = suggestNewKey(k.path);
      console.log(`  - \x1b[31m${k.path}\x1b[0m\n    ➔ \x1b[32m${suggested}\x1b[0m`);
      groupReplacements.push({ oldKey: k.path, newKey: suggested });
    });

    const answer = await askQuestion("\nAction : [Entrée] Valider tout | [s] Ignorer | [m] Modifier : ");
    const choice = answer.trim().toLowerCase();

    if (choice === 's') {
      console.log("⏩ Groupe ignoré.");
      continue;
    }

    let finalReplacements = groupReplacements;
    if (choice === 'm') {
      finalReplacements = [];
      for (const item of groupReplacements) {
        const ans = await askQuestion(`  Prop: ${item.newKey}\n  [Entrée] accepter, ou taper le nouveau nom : `);
        finalReplacements.push({ oldKey: item.oldKey, newKey: ans.trim() !== '' ? ans.trim() : item.newKey });
      }
    }

    console.log("⏳ Vérification des utilisations (Code & Quarantaine)...");

    const validReplacements = [];
    const statsTracker = {};

    // --- PHASE 1 : ANALYSE (Dry Run) ---
    for (const { oldKey, newKey } of finalReplacements) {
      let codeFilesCount = 0;
      let inQuarantined = false;

      // Cherche dans le code
      const regex = new RegExp(`(['"\`])${oldKey.replace(/\./g, '\\.')}\\1`, 'g');
      for (const file of codeFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (regex.test(content)) {
          codeFilesCount++;
        }
      }

      // Cherche dans quarantinedKeys
      for (const fileObj of translations) {
        if (fileObj.content.quarantinedKeys && fileObj.content.quarantinedKeys[oldKey]) {
          inQuarantined = true;
          break;
        }
      }

      statsTracker[oldKey] = { codeFilesCount, inQuarantined };

      if (codeFilesCount > 0 || inQuarantined) {
        validReplacements.push({ oldKey, newKey });
      }
    }

    // --- PHASE 2 : APPLICATION ET TRI (Seulement sur les clés valides) ---
    if (validReplacements.length > 0) {
      // 1. Mise à jour et tri des JSON de traduction
      translations.forEach(fileObj => {
        let fileModified = false;

        validReplacements.forEach(({ oldKey, newKey }) => {
          const res = updateJsonObject(fileObj.content, oldKey, newKey);
          const qRes = updateQuarantinedKeys(fileObj.content, oldKey, newKey);
          if (res || qRes) fileModified = true;
        });

        if (fileModified) {
          // 🆕 On trie tout l'objet de traduction avant de le sauvegarder
          fileObj.content = sortObjectKeys(fileObj.content);
          fs.writeFileSync(fileObj.path, JSON.stringify(fileObj.content, null, 2), 'utf-8');
        }
      });

      // 2. Mise à jour du code front-end
      const regexes = validReplacements.map(r => ({
        oldRegex: new RegExp(`(['"\`])${r.oldKey.replace(/\./g, '\\.')}\\1`, 'g'),
        newKey: r.newKey
      }));

      codeFiles.forEach(file => {
        let content = fs.readFileSync(file, 'utf-8');
        let fileModified = false;

        regexes.forEach(({ oldRegex, newKey }) => {
          if (oldRegex.test(content)) {
            content = content.replace(oldRegex, `$1${newKey}$1`);
            fileModified = true;
          }
        });

        if (fileModified) {
          fs.writeFileSync(file, content, 'utf-8');
        }
      });
    }

    // --- BILAN VISUEL ---
    console.log(`\n📊 Bilan pour le groupe :`);
    finalReplacements.forEach(({ oldKey }) => {
      const s = statsTracker[oldKey];

      if (s.codeFilesCount > 0 || s.inQuarantined) {
        let messages = [];
        if (s.codeFilesCount > 0) {
          messages.push(`Code mis à jour (${s.codeFilesCount} fichier(s))`);
          totalCodeFilesUpdated += s.codeFilesCount;
        }
        if (s.inQuarantined) messages.push(`Mise à jour dans quarantinedKeys`);
        
        console.log(`  ✔️  \x1b[32m${oldKey}\x1b[0m : ${messages.join(' | ')}`);
      } else {
        console.log(`  🚫  \x1b[31m${oldKey}\x1b[0m : Ignoré (introuvable) - JSON non modifié.`);
      }
    });
  }

  console.log("\n🎉 Traitement terminé avec succès !");
  rl.close();
}

main();