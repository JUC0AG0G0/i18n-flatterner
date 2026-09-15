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

  if (translations.length === 0) {
    console.error("❌ Aucun fichier de traduction trouvé.");
    process.exit(1);
  }

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

  const allFiles = getAllFiles(config.projectRoot);
  const sourceFiles = [];
  const testFiles = [];

  allFiles.forEach(file => {
    const isTestFile = config.testFilePatterns && config.testFilePatterns.some(pattern => file.includes(pattern));
    if (isTestFile) testFiles.push(file);
    else sourceFiles.push(file);
  });

  let totalCodeFilesUpdated = 0;
  let totalTestFilesUpdated = 0;
  let isAutoMode = !!config.autoMode;

  const ignoredReport = [];

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

    let choice = '';
    let finalReplacements = groupReplacements;

    if (!isAutoMode) {
      const answer = await askQuestion("\nAction : [Entrée] Valider tout | [s] Ignorer | [m] Modifier | [a] Mode auto : ");
      choice = answer.trim().toLowerCase();

      if (choice === 'a') {
        isAutoMode = true;
        console.log("🤖 Mode automatique activé pour le reste des groupes !");
        choice = '';
      }
    } else {
      console.log("🤖 Validation automatique du groupe...");
    }

    if (choice === 's') {
      console.log("⏩ Groupe ignoré.");
      keys.forEach(k => {
        ignoredReport.push({ key: k.path, reason: "Ignoré manuellement par l'utilisateur." });
      });
      continue;
    }

    if (choice === 'm') {
      finalReplacements = [];
      for (const item of groupReplacements) {
        const ans = await askQuestion(`  Prop: ${item.newKey}\n  [Entrée] accepter, ou taper le nouveau nom : `);
        finalReplacements.push({ oldKey: item.oldKey, newKey: ans.trim() !== '' ? ans.trim() : item.newKey });
      }
    }

    console.log("⏳ Vérification conditionnelle (Source vs Tests)...");

    const validReplacements = [];
    const statsTracker = {};

    // --- PHASE 1 : ANALYSE ---
    for (const { oldKey, newKey } of finalReplacements) {
      let sourceFilesCount = 0;
      let testFilesCount = 0;
      let inQuarantined = false;

      const regex = new RegExp(`(?<![\\w.])${oldKey.replace(/\./g, '\\.')}(?![\\w.])`, 'g');
      
      for (const file of sourceFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (regex.test(content)) sourceFilesCount++;
      }

      for (const file of testFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (regex.test(content)) testFilesCount++;
      }

      for (const fileObj of translations) {
        if (fileObj.content.quarantinedKeys && fileObj.content.quarantinedKeys[oldKey]) {
          inQuarantined = true;
          break;
        }
      }

      statsTracker[oldKey] = { sourceFilesCount, testFilesCount, inQuarantined };

      if (sourceFilesCount > 0 || inQuarantined) {
        validReplacements.push({ oldKey, newKey });
      } else {
        let reason = "";
        if (testFilesCount > 0) {
          reason = `Trouvé uniquement dans ${testFilesCount} test(s) (Clé dynamique probable).`;
        } else {
          reason = `Introuvable nulle part dans le projet (Code source, Quarantaine ou Tests).`;
        }
        ignoredReport.push({ key: oldKey, reason: reason });
      }
    }

    // --- PHASE 2 : APPLICATION ---
    if (validReplacements.length > 0) {
      translations.forEach(fileObj => {
        let fileModified = false;
        validReplacements.forEach(({ oldKey, newKey }) => {
          const res = updateJsonObject(fileObj.content, oldKey, newKey);
          const qRes = updateQuarantinedKeys(fileObj.content, oldKey, newKey);
          if (res || qRes) fileModified = true;
        });

        if (fileModified) {
          fileObj.content = sortObjectKeys(fileObj.content);
          fs.writeFileSync(fileObj.path, JSON.stringify(fileObj.content, null, 2), 'utf-8');
        }
      });

      const regexes = validReplacements.map(r => ({
        // 🆕 Même regex pour le remplacement
        oldRegex: new RegExp(`(?<![\\w.])${r.oldKey.replace(/\./g, '\\.')}(?![\\w.])`, 'g'),
        newKey: r.newKey
      }));

      [...sourceFiles, ...testFiles].forEach(file => {
        let content = fs.readFileSync(file, 'utf-8');
        let fileModified = false;

        regexes.forEach(({ oldRegex, newKey }) => {
          if (oldRegex.test(content)) {
            // 🆕 On remplace directement (plus besoin de capturer les guillemets)
            content = content.replace(oldRegex, newKey);
            fileModified = true;
          }
        });

        if (fileModified) {
          fs.writeFileSync(file, content, 'utf-8');
        }
      });
    }

    console.log(`\n📊 Bilan pour le groupe :`);
    finalReplacements.forEach(({ oldKey }) => {
      const s = statsTracker[oldKey];

      if (s.sourceFilesCount > 0 || s.inQuarantined) {
        let messages = [];
        if (s.sourceFilesCount > 0) {
          messages.push(`Source (${s.sourceFilesCount} f.)`);
          totalCodeFilesUpdated += s.sourceFilesCount;
        }
        if (s.testFilesCount > 0) {
          messages.push(`Tests (${s.testFilesCount} f.)`);
          totalTestFilesUpdated += s.testFilesCount;
        }
        if (s.inQuarantined) messages.push(`Quarantaine`);
        
        console.log(`  ✔️  \x1b[32m${oldKey}\x1b[0m : Mis à jour [${messages.join(' | ')}]`);
      } else {
        if (s.testFilesCount > 0) {
          console.log(`  🚫  \x1b[33m${oldKey}\x1b[0m : Ignoré (Trouvé UNIQUEMENT dans ${s.testFilesCount} test(s))`);
        } else {
          console.log(`  🚫  \x1b[31m${oldKey}\x1b[0m : Ignoré (Introuvable partout)`);
        }
      }
    });
  }

  if (ignoredReport.length > 0) {
    const reportPath = './ignored_keys_report.md';
    let reportContent = '# Rapport des clés de traduction non modifiées\n\n';
    reportContent += `*Généré le : ${new Date().toLocaleString('fr-FR')}*\n\n`;
    reportContent += `Ces clés ont été identifiées comme ayant une profondeur excessive, mais n'ont **pas** été modifiées dans vos fichiers JSON afin de ne rien casser.\n\n`;
    reportContent += `### Détail des clés ignorées :\n\n`;
    
    ignoredReport.forEach(item => {
      reportContent += `- **\`${item.key}\`** : ${item.reason}\n`;
    });

    fs.writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n📄 \x1b[36mUn rapport des clés ignorées a été généré : ${reportPath}\x1b[0m`);
  } else {
    console.log(`\n📄 Aucune clé n'a été ignorée, le rapport n'est pas nécessaire.`);
  }

  console.log("\n🎉 Traitement terminé avec succès !");
  console.log(`Total occurrences modifiées (Sources) : ${totalCodeFilesUpdated}`);
  console.log(`Total occurrences modifiées (Tests)   : ${totalTestFilesUpdated}`);
  rl.close();
}

main();
