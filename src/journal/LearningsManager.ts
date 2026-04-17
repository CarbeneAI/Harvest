#!/usr/bin/env bun
/**
 * LearningsManager.ts - Trading Learnings CRUD Manager
 *
 * Manages trading learnings with CRUD operations.
 * Stores learnings in data/learnings.md with salience scoring.
 *
 * Usage:
 *   bun LearningsManager.ts add --title "Buy dips after earnings" --learning "When stock dips 2-3% after beat..." --source "AAPL 2025-01-15"
 *   bun LearningsManager.ts list
 *   bun LearningsManager.ts get L-20250127-001
 *   bun LearningsManager.ts remove L-20250127-001
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';

// Parse command line arguments
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const nextValue = argv[i + 1];
      if (nextValue && !nextValue.startsWith('--')) {
        args[key] = nextValue;
        i++;
      } else {
        args[key] = true;
      }
    } else if (!args._command) {
      args._command = argv[i];
    } else if (!args._arg1) {
      args._arg1 = argv[i];
    }
  }
  return args;
}

const PROJECT_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');

// Learning entry structure
interface Learning {
  id: string;
  title: string;
  score: number;
  lastUpdated: string;
  learning: string;
  source: string;
  tags: string[];
}

// Generate learning ID
function generateLearningId(): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const learningsFile = join(PROJECT_ROOT, 'data', 'learnings.md');

  let maxSeq = 0;
  if (existsSync(learningsFile)) {
    const content = readFileSync(learningsFile, 'utf-8');
    const pattern = new RegExp(`L-${dateStr}-(\\d{3})`, 'g');
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const seq = parseInt(match[1], 10);
      if (seq > maxSeq) maxSeq = seq;
    }
  }

  const nextSeq = maxSeq + 1;
  return `L-${dateStr}-${nextSeq.toString().padStart(3, '0')}`;
}

// Parse learnings file
function parseLearningsFile(filepath: string): Learning[] {
  if (!existsSync(filepath)) {
    return [];
  }

  const content = readFileSync(filepath, 'utf-8');
  const learnings: Learning[] = [];

  // Split by learning entries (## [ID] Title)
  const entries = content.split(/^## /m).filter(e => e.trim());

  for (const entry of entries) {
    const lines = entry.split('\n');
    const titleLine = lines[0];

    // Parse ID and title
    const idMatch = titleLine.match(/^\[([^\]]+)\]\s+(.+)$/);
    if (!idMatch) continue;

    const id = idMatch[1];
    const title = idMatch[2];

    // Parse metadata
    let score = 0.5;
    let lastUpdated = new Date().toISOString().split('T')[0];
    let learningText = '';
    let source = '';
    let tags: string[] = [];

    let inLearning = false;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.match(/^-\s+\*\*Score:\*\*/)) {
        const match = line.match(/^-\s+\*\*Score:\*\*\s+([\d.]+)/);
        if (match) score = parseFloat(match[1]);
      } else if (line.match(/^-\s+\*\*Last updated:\*\*/)) {
        const match = line.match(/^-\s+\*\*Last updated:\*\*\s+(.+)$/);
        if (match) lastUpdated = match[1];
      } else if (line.match(/^-\s+\*\*Learning:\*\*/)) {
        const match = line.match(/^-\s+\*\*Learning:\*\*\s+(.+)$/);
        if (match) learningText = match[1];
        inLearning = true;
      } else if (line.match(/^-\s+\*\*Source:\*\*/)) {
        const match = line.match(/^-\s+\*\*Source:\*\*\s+(.+)$/);
        if (match) source = match[1];
        inLearning = false;
      } else if (line.match(/^-\s+\*\*Tags:\*\*/)) {
        const match = line.match(/^-\s+\*\*Tags:\*\*\s+(.+)$/);
        if (match) tags = match[1].split(',').map(t => t.trim());
        inLearning = false;
      } else if (inLearning && line.trim()) {
        learningText += ' ' + line.trim();
      }
    }

    learnings.push({
      id,
      title,
      score,
      lastUpdated,
      learning: learningText,
      source,
      tags,
    });
  }

  return learnings;
}

// Add new learning
function addLearning(params: {
  title: string;
  learning: string;
  source: string;
  tags?: string[];
}): Learning {
  const id = generateLearningId();
  const now = new Date().toISOString().split('T')[0];

  return {
    id,
    title: params.title,
    score: 0.5,
    lastUpdated: now,
    learning: params.learning,
    source: params.source,
    tags: params.tags || [],
  };
}

// Format learning as markdown
function formatLearning(learning: Learning): string {
  const tagsStr = learning.tags.length > 0 ? learning.tags.join(', ') : 'none';

  return `## [${learning.id}] ${learning.title}

- **Score:** ${learning.score.toFixed(2)}
- **Last updated:** ${learning.lastUpdated}
- **Learning:** ${learning.learning}
- **Source:** ${learning.source}
- **Tags:** ${tagsStr}`;
}

// Write learnings to file
function writeLearningsFile(filepath: string, learnings: Learning[]) {
  const header = `# Trading Learnings

Active learnings with salience scores. Scores decay -0.02/week.
- Score > 0.8: Promoted to data/trading-docs/
- Score < 0.2: Archived to data/archive/

`;

  const content = header + learnings.map(l => formatLearning(l)).join('\n\n');

  const dir = join(filepath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(filepath, content, 'utf-8');
}

// Archive learning
function archiveLearning(learning: Learning): string {
  const yearMonth = new Date().toISOString().slice(0, 7);
  const archiveDir = join(PROJECT_ROOT, 'data', 'archive', yearMonth);
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }

  const filename = `archived-${learning.id}.md`;
  const filepath = join(archiveDir, filename);
  const content = formatLearning(learning);
  writeFileSync(filepath, content, 'utf-8');

  return filepath;
}

// Show help
function showHelp() {
  console.log(`
Trading Learnings Manager

Usage:
  bun LearningsManager.ts <command> [options]

Commands:
  add           Add new learning
  list          List all learnings
  get <id>      Get specific learning
  remove <id>   Archive a learning

Add Options:
  --title <text>     Learning title
  --learning <text>  Learning description
  --source <text>    Source (trade, observation, etc.)
  --tags <tags>      Comma-separated tags (optional)

Examples:
  # Add new learning
  bun LearningsManager.ts add --title "Buy dips after earnings beat" --learning "When stock dips 2-3% after beating earnings, it typically recovers within 3 days" --source "AAPL trade 2025-01-15" --tags "earnings,momentum"

  # List all learnings
  bun LearningsManager.ts list

  # Get specific learning
  bun LearningsManager.ts get L-20250127-001

  # Archive learning
  bun LearningsManager.ts remove L-20250127-001

Learning IDs:
  Format: L-YYYYMMDD-XXX (e.g., L-20250127-001)
  - L: Learning prefix
  - YYYYMMDD: Date created
  - XXX: Sequential number (001, 002, etc.)
`);
}

// Main execution
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const command = args._command as string;
  const learningsFile = join(PROJECT_ROOT, 'data', 'learnings.md');

  try {
    switch (command) {
      case 'add': {
        if (!args.title || !args.learning || !args.source) {
          console.error('Error: --title, --learning, and --source are required');
          showHelp();
          process.exit(1);
        }

        const tags = args.tags ? (args.tags as string).split(',').map(t => t.trim()) : [];

        const newLearning = addLearning({
          title: args.title as string,
          learning: args.learning as string,
          source: args.source as string,
          tags,
        });

        // Read existing learnings
        const learnings = parseLearningsFile(learningsFile);
        learnings.push(newLearning);

        // Write back
        writeLearningsFile(learningsFile, learnings);

        console.log(JSON.stringify({
          success: true,
          action: 'added',
          learning: newLearning,
        }, null, 2));
        break;
      }

      case 'list': {
        const learnings = parseLearningsFile(learningsFile);

        console.log(JSON.stringify({
          count: learnings.length,
          learnings: learnings.map(l => ({
            id: l.id,
            title: l.title,
            score: l.score,
            lastUpdated: l.lastUpdated,
          })),
        }, null, 2));
        break;
      }

      case 'get': {
        const id = args._arg1 as string;
        if (!id) {
          console.error('Error: Learning ID required');
          process.exit(1);
        }

        const learnings = parseLearningsFile(learningsFile);
        const learning = learnings.find(l => l.id === id);

        if (!learning) {
          console.error(`Error: Learning ${id} not found`);
          process.exit(1);
        }

        console.log(JSON.stringify(learning, null, 2));
        break;
      }

      case 'remove': {
        const id = args._arg1 as string;
        if (!id) {
          console.error('Error: Learning ID required');
          process.exit(1);
        }

        const learnings = parseLearningsFile(learningsFile);
        const learning = learnings.find(l => l.id === id);

        if (!learning) {
          console.error(`Error: Learning ${id} not found`);
          process.exit(1);
        }

        // Archive the learning
        const archivePath = archiveLearning(learning);

        // Remove from active learnings
        const remaining = learnings.filter(l => l.id !== id);
        writeLearningsFile(learningsFile, remaining);

        console.log(JSON.stringify({
          success: true,
          action: 'removed',
          id,
          archivePath,
        }, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        showHelp();
        process.exit(1);
    }

    process.exit(0);

  } catch (error) {
    console.error(`Command failed: ${error}`);
    process.exit(1);
  }
}

main();
