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

function fileLink(filePath) {
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

  const sourceFiles = [];
  const testFiles = [];

  // 1. Scan Front-end
  const allClientFiles = getAllFiles(config.projectRoot);
  allClientFiles.forEach(file => {
    const isTestFile = config.testFilePatterns && config.testFilePatterns.some(pattern => file.includes(pattern));
    if (isTestFile) testFiles.push(file);
    else sourceFiles.push(file);
  });

  // 2. Scan E2E (ajouté aux tests)
  if (config.e2eRoot && fs.existsSync(config.e2eRoot)) {
    const e2eFiles = getAllFiles(config.e2eRoot);
    testFiles.push(...e2eFiles);
  }

  // 3. Scan Backend (ajouté aux sources)
  if (config.backendRoot && fs.existsSync(config.backendRoot)) {
    const backendFiles = getAllFiles(config.backendRoot);
    sourceFiles.push(...backendFiles);
    console.log(`📌 ${backendFiles.length} fichiers Backend détectés.`);
  }

  let totalCodeFilesUpdated = 0;
  let totalTestFilesUpdated = 0;
  let isAutoMode = !!config.autoMode;

  const fullReport = {};

  for (const [parentPath, keys] of Object.entries(groups)) {
    console.log(`\n======================================================`);
    console.log(`📂 Groupe : \x1b[36m${parentPath}\x1b[0m (${keys.length} clés)`);
    console.log(`======================================================`);
    
    fullReport[parentPath] = { updated: [], quarantined: [], ignored: [] };
    const groupReplacements = [];

    keys.forEach(k => {
      const suggested = suggestNewKey(k.path);
      console.log(`  - \x1b[31m${k.path}\x1b[0m\n    ➔ \x1b[32m${suggested}\x1b[0m`);
      groupReplacements.push({ oldKey: k.path, newKey: suggested });
    });

    let choice = '';
    let finalReplacements = groupReplacements;

    if (!isAutoMode) {
      const answer = await askQuestion("\nAction : [Entrée] Valider tout | [s] Ignorer | [m] Modifier | [a] Mode auto | [q] Quitter : ");
      choice = answer.trim().toLowerCase();

      if (choice === 'a') {
        isAutoMode = true;
        console.log("🤖 Mode automatique activé pour le reste des groupes !");
        choice = '';
      }
    } else {
      console.log("🤖 Validation automatique du groupe...");
    }

    if (choice === 'q') {
      console.log("🛑 Arrêt prématuré du programme. Génération du rapport en cours...");
      keys.forEach(k => {
        fullReport[parentPath].ignored.push({ key: k.path, reason: "Arrêt du script en cours de traitement." });
      });
      break;
    }

    if (choice === 's') {
      console.log("⏩ Groupe ignoré.");
      keys.forEach(k => {
        fullReport[parentPath].ignored.push({ key: k.path, reason: "Ignoré manuellement par l'utilisateur." });
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

    console.log("⏳ Vérification conditionnelle (Source vs Tests vs Dynamique)...");

    const replacementsToApply = [];
    const statsTracker = {};

    // --- PHASE 1 : ANALYSE ---
    for (const { oldKey, newKey } of finalReplacements) {
      let sourceFilesFound = [];
      let testFilesFound = [];
      let dynamicFilesFound = [];
      let inQuarantined = false;

      const exactRegex = new RegExp(`(?<![\\w.])${oldKey.replace(/\./g, '\\.')}(?![\\w.])`, 'g');
      
      for (const file of sourceFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (exactRegex.test(content)) sourceFilesFound.push(file);
      }

      for (const file of testFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (exactRegex.test(content)) testFilesFound.push(file);
      }

      for (const fileObj of translations) {
        if (fileObj.content.quarantinedKeys && fileObj.content.quarantinedKeys[oldKey]) {
          inQuarantined = true;
          break;
        }
      }

      // RECHERCHE DYNAMIQUE (Si la clé exacte n'a pas été trouvée)
      if (config.detectDynamicUsage && sourceFilesFound.length === 0 && !inQuarantined) {
        const dynamicParent = oldKey.split('.').slice(0, -1).join('.') + '.';
        const dynamicRegex = new RegExp(`(?<![\\w.])${dynamicParent.replace(/\./g, '\\.')}`, 'g');
        for (const file of sourceFiles) {
          const content = fs.readFileSync(file, 'utf-8');
          if (dynamicRegex.test(content)) dynamicFilesFound.push(file);
        }
      }

      // DÉCISION DE L'ACTION
      let action = 'IGNORE';
      if (sourceFilesFound.length > 0 || inQuarantined) {
        action = 'UPDATE_ALL';
        fullReport[parentPath].updated.push({ oldKey, newKey, sourceFilesFound, testFilesFound, inQuarantined });
      } else if (config.quarantineUnfoundKeys) {
        action = 'QUARANTINE';
        let reason = dynamicFilesFound.length > 0 
          ? `Usage dynamique détecté via le préfixe (${dynamicFilesFound.length} fichier(s)).`
          : (testFilesFound.length > 0 ? `Uniquement dans ${testFilesFound.length} test(s).` : `Introuvable.`);
        
        fullReport[parentPath].quarantined.push({ oldKey, newKey, reason, dynamicFilesFound, testFilesFound });
      } else {
        let reason = testFilesFound.length > 0 
          ? `Trouvé uniquement dans ${testFilesFound.length} test(s) (Clé dynamique probable).` 
          : `Introuvable partout et mode quarantaine désactivé.`;
        fullReport[parentPath].ignored.push({ key: oldKey, reason, testFilesFound });
      }

      statsTracker[oldKey] = { sourceFilesFound, testFilesFound, dynamicFilesFound, inQuarantined, action };
      if (action !== 'IGNORE') replacementsToApply.push({ oldKey, newKey, action });
    }

    // --- PHASE 2 : APPLICATION ---
    if (replacementsToApply.length > 0) {
      translations.forEach(fileObj => {
        let fileModified = false;
        if (!fileObj.content.quarantinedKeys) fileObj.content.quarantinedKeys = {};

        replacementsToApply.forEach(({ oldKey, newKey, action }) => {
          if (action === 'UPDATE_ALL') {
            const res = updateJsonObject(fileObj.content, oldKey, newKey);
            const qRes = updateQuarantinedKeys(fileObj.content, oldKey, newKey);
            if (res || qRes) fileModified = true;
          } 
          else if (action === 'QUARANTINE') {
            // Extraction sécurisée de la valeur existante
            const oldParts = oldKey.split('.');
            let current = fileObj.content;
            let found = true;
            for (let i = 0; i < oldParts.length - 1; i++) {
              current = current?.[oldParts[i]];
              if (!current) { found = false; break; }
            }
            
            if (found && (oldParts[oldParts.length - 1] in current)) {
              const val = current[oldParts[oldParts.length - 1]];

              // 1. Aplati et met à jour à l'emplacement d'origine
              updateJsonObject(fileObj.content, oldKey, newKey);
              
              // 2. Ajoute en plus une copie dans les clés en quarantaine
              fileObj.content.quarantinedKeys[newKey] = val;
              fileModified = true;
            }
          }
        });

        if (fileModified) {
          fileObj.content = sortObjectKeys(fileObj.content);
          fs.writeFileSync(fileObj.path, JSON.stringify(fileObj.content, null, 2), 'utf-8');
        }
      });

      // Code ET Tests (uniquement pour les clés UPDATE_ALL)
      const replacementsToUpdateCode = replacementsToApply.filter(r => r.action === 'UPDATE_ALL');
      if (replacementsToUpdateCode.length > 0) {
        const regexes = replacementsToUpdateCode.map(r => ({
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
    }

    // --- BILAN VISUEL DANS LE TERMINAL ---
    console.log(`\n📊 Bilan pour le groupe :`);
    
    finalReplacements.forEach(({ oldKey }) => {
      const s = statsTracker[oldKey];
      
      if (s.action === 'UPDATE_ALL') {
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
        
      } else if (s.action === 'QUARANTINE') {
        let dMsg = s.dynamicFilesFound.length > 0 ? ` (Dynamique détecté)` : ` (Introuvable)`;
        console.log(`  🛡️  \x1b[34m${oldKey}\x1b[0m : Aplati et copié en quarantaine${dMsg}`);
        
      } else if (s.action === 'IGNORE') {
        if (s.testFilesFound.length > 0) {
          console.log(`  🚫  \x1b[33m${oldKey}\x1b[0m : Ignoré (Trouvé UNIQUEMENT dans ${s.testFilesFound.length} test(s))`);
        } else {
          console.log(`  🚫  \x1b[31m${oldKey}\x1b[0m : Ignoré (Introuvable partout et quarantaine désactivée)`);
        }
      }
    });
  }

  // --- GÉNÉRATION DU RAPPORT COMPLET ---
  const reportPath = './ignored_keys_report.md';
  let reportContent = '# 📋 Rapport de refactoring des clés de traduction\n\n';
  reportContent += `*Généré le : ${new Date().toLocaleString('fr-FR')}*\n\n`;
  reportContent += `---\n\n`;

  let reportHasContent = false;

  for (const [groupPath, data] of Object.entries(fullReport)) {
    if (data.updated.length === 0 && data.quarantined.length === 0 && data.ignored.length === 0) continue;
    reportHasContent = true;

    reportContent += `## 📂 Groupe : \`${groupPath}\`\n\n`;

    if (data.updated.length > 0) {
      reportContent += `### ✅ Clés trouvées et mises à jour\n\n`;
      data.updated.forEach(item => {
        reportContent += `**Ancienne :** \`${item.oldKey}\`  \n**Nouvelle :** \`${item.newKey}\`\n\n`;
        if (item.sourceFilesFound.length > 0) {
          reportContent += `📄 **Sources modifiées :**\n${item.sourceFilesFound.map(f => `- ${fileLink(f)}`).join('\n')}\n\n`;
        }
        if (item.testFilesFound.length > 0) {
          reportContent += `🧪 **Tests modifiés :**\n${item.testFilesFound.map(f => `- ${fileLink(f)}`).join('\n')}\n\n`;
        }
        reportContent += `---\n\n`;
      });
    }

    if (data.quarantined.length > 0) {
      reportContent += `### 🛡️ Clés aplaties et mises en quarantaine\n*La clé a été aplatie à son emplacement d'origine ET une copie a été ajoutée dans \`quarantinedKeys\`. Le code source n'a pas été modifié.*\n\n`;
      data.quarantined.forEach(item => {
        reportContent += `> 🛡️ **De :** \`${item.oldKey}\`  \n> 🛡️ **Vers :** \`${item.newKey}\`\n>\n> *Raison : ${item.reason}*\n\n`;
        if (item.dynamicFilesFound && item.dynamicFilesFound.length > 0) {
          reportContent += `🔍 **Fichiers avec usage dynamique potentiel (à vérifier) :**\n${item.dynamicFilesFound.map(f => `- ${fileLink(f)}`).join('\n')}\n\n`;
        }
        if (item.testFilesFound && item.testFilesFound.length > 0) {
          reportContent += `🧪 **Tests contenant l'ancienne clé (à corriger manuellement) :**\n${item.testFilesFound.map(f => `- ${fileLink(f)}`).join('\n')}\n\n`;
        }
        reportContent += `---\n\n`;
      });
    }

    if (data.ignored.length > 0) {
      reportContent += `### 🚫 Clés ignorées (Non modifiées du tout)\n\n`;
      data.ignored.forEach(item => {
        reportContent += `> ⚠️ **\`${item.key}\`**\n>\n> *Raison : ${item.reason}*\n\n`;
        
        if (item.testFilesFound && item.testFilesFound.length > 0) {
          reportContent += `🧪 **Tests contenant l'ancienne clé :**\n${item.testFilesFound.map(f => `- ${fileLink(f)}`).join('\n')}\n\n`;
        }
        
        reportContent += `---\n\n`;
      });
    }
  }

  if (reportHasContent) {
    fs.writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n📄 \x1b[36mLe rapport détaillé a été généré : ${reportPath}\x1b[0m`);
  }

  console.log("\n🎉 Traitement terminé avec succès !");
  console.log(`Total occurrences modifiées (Sources) : ${totalCodeFilesUpdated}`);
  console.log(`Total occurrences modifiées (Tests)   : ${totalTestFilesUpdated}`);
  rl.close();
}

main();
