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
  if (!dirPath || !fs.existsSync(dirPath)) return arrayOfFiles;
  
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

// 🆕 Helper pour formater les liens Markdown
function fileLink(filePath) {
  // Remplace les antislashs de Windows par des slashs standards pour garantir que les liens marchent partout
  const normalizedPath = filePath.replace(/\\/g, '/');
  return `[${normalizedPath}](${normalizedPath})`;
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

  // Séparation des fichiers
  const allClientFiles = getAllFiles(config.projectRoot);
  const sourceFiles = [];
  const testFiles = [];

  allClientFiles.forEach(file => {
    const isTestFile = config.testFilePatterns && config.testFilePatterns.some(pattern => file.includes(pattern));
    if (isTestFile) testFiles.push(file);
    else sourceFiles.push(file);
  });

  if (config.e2eRoot && fs.existsSync(config.e2eRoot)) {
    const e2eFiles = getAllFiles(config.e2eRoot);
    testFiles.push(...e2eFiles);
    console.log(`📌 ${e2eFiles.length} fichiers E2E détectés.`);
  }

  let totalCodeFilesUpdated = 0;
  let totalTestFilesUpdated = 0;
  let isAutoMode = !!config.autoMode;

  // 🆕 Objet global pour construire le rapport complet par groupe
  const fullReport = {};

  for (const [parentPath, keys] of Object.entries(groups)) {
    console.log(`\n======================================================`);
    console.log(`📂 Groupe : \x1b[36m${parentPath}\x1b[0m (${keys.length} clés)`);
    console.log(`======================================================`);
    
    // Initialisation du rapport pour ce groupe
    fullReport[parentPath] = { updated: [], ignored: [] };

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
        fullReport[parentPath].ignored.push({ key: k.path, reason: "Ignoré manuellement par l'utilisateur.", testFilesFound: [] });
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
      let sourceFilesFound = [];
      let testFilesFound = [];
      let inQuarantined = false;

      const regex = new RegExp(`(?<![\\w.])${oldKey.replace(/\./g, '\\.')}(?![\\w.])`, 'g');
      
      for (const file of sourceFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (regex.test(content)) sourceFilesFound.push(file);
      }

      for (const file of testFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (regex.test(content)) testFilesFound.push(file);
      }

      for (const fileObj of translations) {
        if (fileObj.content.quarantinedKeys && fileObj.content.quarantinedKeys[oldKey]) {
          inQuarantined = true;
          break;
        }
      }

      statsTracker[oldKey] = { sourceFilesFound, testFilesFound, inQuarantined };

      if (sourceFilesFound.length > 0 || inQuarantined) {
        validReplacements.push({ oldKey, newKey });
        fullReport[parentPath].updated.push({ oldKey, newKey, sourceFilesFound, testFilesFound, inQuarantined });
      } else {
        let reason = "";
        if (testFilesFound.length > 0) {
          reason = `Trouvé uniquement dans ${testFilesFound.length} fichier(s) de test (Génération dynamique probable).`;
        } else {
          reason = `Introuvable nulle part dans le projet (Code source, Quarantaine ou Tests).`;
        }
        fullReport[parentPath].ignored.push({ key: oldKey, reason, testFilesFound });
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
        oldRegex: new RegExp(`(?<![\\w.])${r.oldKey.replace(/\./g, '\\.')}(?![\\w.])`, 'g'),
        newKey: r.newKey
      }));

      [...sourceFiles, ...testFiles].forEach(file => {
        let content = fs.readFileSync(file, 'utf-8');
        let fileModified = false;

        regexes.forEach(({ oldRegex, newKey }) => {
          if (oldRegex.test(content)) {
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

      if (s.sourceFilesFound.length > 0 || s.inQuarantined) {
        let messages = [];
        if (s.sourceFilesFound.length > 0) {
          messages.push(`Source (${s.sourceFilesFound.length} f.)`);
          totalCodeFilesUpdated += s.sourceFilesFound.length;
        }
        if (s.testFilesFound.length > 0) {
          messages.push(`Tests (${s.testFilesFound.length} f.)`);
          totalTestFilesUpdated += s.testFilesFound.length;
        }
        if (s.inQuarantined) messages.push(`Quarantaine`);
        
        console.log(`  ✔️  \x1b[32m${oldKey}\x1b[0m : Mis à jour [${messages.join(' | ')}]`);
      } else {
        if (s.testFilesFound.length > 0) {
          console.log(`  🚫  \x1b[33m${oldKey}\x1b[0m : Ignoré (Trouvé UNIQUEMENT dans ${s.testFilesFound.length} test(s))`);
        } else {
          console.log(`  🚫  \x1b[31m${oldKey}\x1b[0m : Ignoré (Introuvable partout)`);
        }
      }
    });
  }

  // 🆕 GÉNÉRATION DU RAPPORT COMPLET
  const reportPath = './ignored_keys_report.md';
  let reportContent = '# 📋 Rapport de refactoring des clés de traduction\n\n';
  reportContent += `*Généré le : ${new Date().toLocaleString('fr-FR')}*\n\n`;
  reportContent += `---\n\n`;

  for (const [groupPath, data] of Object.entries(fullReport)) {
    // Ne pas afficher les groupes complètement vides d'actions
    if (data.updated.length === 0 && data.ignored.length === 0) continue;

    reportContent += `## 📂 Groupe : \`${groupPath}\`\n\n`;

    // 🟢 Section des clés mises à jour
    if (data.updated.length > 0) {
      reportContent += `### ✅ Clés trouvées et mises à jour\n\n`;
      data.updated.forEach(item => {
        reportContent += `**Ancienne :** \`${item.oldKey}\`\n`;
        reportContent += `**Nouvelle :** \`${item.newKey}\`\n\n`;
        
        if (item.inQuarantined) {
          reportContent += `🛡️ *Mise à jour effectuée dans \`quarantinedKeys\`*\n\n`;
        }
        
        if (item.sourceFilesFound.length > 0) {
          reportContent += `📄 **Modifié dans les fichiers sources :**\n`;
          item.sourceFilesFound.forEach(f => {
            reportContent += `- ${fileLink(f)}\n`;
          });
          reportContent += `\n`;
        }

        if (item.testFilesFound.length > 0) {
          reportContent += `🧪 **Modifié dans les fichiers de tests :**\n`;
          item.testFilesFound.forEach(f => {
            reportContent += `- ${fileLink(f)}\n`;
          });
          reportContent += `\n`;
        }
        reportContent += `---\n\n`;
      });
    }

    // 🔴 Section des clés ignorées
    if (data.ignored.length > 0) {
      reportContent += `### 🚫 Clés ignorées (Non modifiées dans le JSON)\n\n`;
      data.ignored.forEach(item => {
        reportContent += `> ⚠️ **\`${item.key}\`**\n>\n> *Raison : ${item.reason}*\n\n`;
        
        if (item.testFilesFound && item.testFilesFound.length > 0) {
          reportContent += `🔍 **Fichiers contenant cette clé (à corriger manuellement si besoin) :**\n`;
          item.testFilesFound.forEach(f => {
            reportContent += `- ${fileLink(f)}\n`;
          });
          reportContent += `\n`;
        }
        reportContent += `---\n\n`;
      });
    }
  }

  fs.writeFileSync(reportPath, reportContent, 'utf-8');
  console.log(`\n📄 \x1b[36mLe rapport ultra-détaillé avec liens cliquables a été généré : ${reportPath}\x1b[0m`);

  console.log("\n🎉 Traitement terminé avec succès !");
  console.log(`Total occurrences modifiées (Sources) : ${totalCodeFilesUpdated}`);
  console.log(`Total occurrences modifiées (Tests)   : ${totalTestFilesUpdated}`);
  rl.close();
}

main();
