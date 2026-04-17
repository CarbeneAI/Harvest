#!/usr/bin/env bun
/**
 * SalienceScorer.ts - Salience Score Calculator
 *
 * Manages salience scores for trading learnings using time-decay and win/loss feedback.
 * Promotes high-scoring learnings (>0.8) and archives low-scoring ones (<0.2).
 *
 * Usage:
 *   bun SalienceScorer.ts --sweep
 *   bun SalienceScorer.ts --update L-20250127-001 --result win
 *   bun SalienceScorer.ts --boost L-20250127-001
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
  lastUpdated: Date;
  content: string;
  rawText: string;
}

// Parse learnings.md file
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

    // Parse score and last updated
    let score = 0.5;
    let lastUpdated = new Date();

    for (const line of lines) {
      const scoreMatch = line.match(/^-\s+\*\*Score:\*\*\s+([\d.]+)/);
      if (scoreMatch) {
        score = parseFloat(scoreMatch[1]);
      }

      const dateMatch = line.match(/^-\s+\*\*Last updated:\*\*\s+(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        lastUpdated = new Date(dateMatch[1]);
      }
    }

    learnings.push({
      id,
      title,
      score,
      lastUpdated,
      content: lines.slice(1).join('\n'),
      rawText: '## ' + entry,
    });
  }

  return learnings;
}

// Write learnings back to file
function writeLearningsFile(filepath: string, learnings: Learning[]) {
  const header = `# Trading Learnings

Active learnings with salience scores. Scores decay -0.02/week.
- Score > 0.8: Promoted to data/trading-docs/
- Score < 0.2: Archived to data/archive/

`;

  const content = header + learnings.map(l => l.rawText).join('\n\n');
  writeFileSync(filepath, content, 'utf-8');
}

// Apply time decay
function applyDecay(learning: Learning): Learning {
  const now = new Date();
  const weeksSinceUpdate = (now.getTime() - learning.lastUpdated.getTime()) / (1000 * 60 * 60 * 24 * 7);
  const decay = weeksSinceUpdate * 0.02;
  const newScore = Math.max(0, learning.score - decay);

  return {
    ...learning,
    score: newScore,
  };
}

// Update score based on win/loss
function updateScore(learning: Learning, result: 'win' | 'loss'): Learning {
  const adjustment = result === 'win' ? 0.1 : -0.15;
  const newScore = Math.max(0, Math.min(1.0, learning.score + adjustment));

  return {
    ...learning,
    score: newScore,
    lastUpdated: new Date(),
  };
}

// Boost score manually
function boostScore(learning: Learning): Learning {
  const newScore = Math.min(1.0, learning.score + 0.2);

  return {
    ...learning,
    score: newScore,
    lastUpdated: new Date(),
  };
}

// Update learning in raw text
function updateLearningText(learning: Learning): Learning {
  const lines = learning.rawText.split('\n');
  const dateStr = learning.lastUpdated.toISOString().split('T')[0];

  // Update score line
  let scoreUpdated = false;
  let dateUpdated = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^-\s+\*\*Score:\*\*/)) {
      lines[i] = `- **Score:** ${learning.score.toFixed(2)}`;
      scoreUpdated = true;
    }
    if (lines[i].match(/^-\s+\*\*Last updated:\*\*/)) {
      lines[i] = `- **Last updated:** ${dateStr}`;
      dateUpdated = true;
    }
  }

  // Add missing fields
  if (!scoreUpdated) {
    lines.splice(1, 0, `- **Score:** ${learning.score.toFixed(2)}`);
  }
  if (!dateUpdated) {
    lines.splice(scoreUpdated ? 2 : 1, 0, `- **Last updated:** ${dateStr}`);
  }

  return {
    ...learning,
    rawText: lines.join('\n'),
  };
}

// Promote learning
function promoteLearning(learning: Learning): string {
  const docsDir = join(PROJECT_ROOT, 'data', 'trading-docs');
  if (!existsSync(docsDir)) {
    mkdirSync(docsDir, { recursive: true });
  }

  const filename = `promoted-${learning.id}.md`;
  const filepath = join(docsDir, filename);
  writeFileSync(filepath, learning.rawText, 'utf-8');

  return filepath;
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
  writeFileSync(filepath, learning.rawText, 'utf-8');

  return filepath;
}

// Show help
function showHelp() {
  console.log(`
Salience Score Calculator

Usage:
  bun SalienceScorer.ts [command] [options]

Commands:
  --sweep                Run full sweep (apply decay, promote/archive)
  --update <id>          Update specific learning
  --boost <id>           Manually boost learning score by +0.2

Update Options:
  --result <win|loss>    Adjust score based on trade result

Examples:
  bun SalienceScorer.ts --sweep
  bun SalienceScorer.ts --update L-20250127-001 --result win
  bun SalienceScorer.ts --update L-20250127-001 --result loss
  bun SalienceScorer.ts --boost L-20250127-001

Salience Rules:
  - Decay: -0.02 per week since last update
  - Win: +0.1 to score
  - Loss: -0.15 to score
  - Boost: +0.2 to score
  - Promote: Score > 0.8 to data/trading-docs/
  - Archive: Score < 0.2 to data/archive/YYYY-MM/

Output:
  JSON summary with counts and details of changes
`);
}

// Main execution
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const learningsFile = join(PROJECT_ROOT, 'data', 'learnings.md');

  if (!existsSync(learningsFile)) {
    console.error('Error: learnings.md not found');
    process.exit(1);
  }

  let learnings = parseLearningsFile(learningsFile);

  const result: any = {
    swept: 0,
    promoted: 0,
    archived: 0,
    active: learnings.length,
    details: [],
  };

  if (args.sweep) {
    // Apply decay to all learnings
    const toPromote: Learning[] = [];
    const toArchive: Learning[] = [];
    const toKeep: Learning[] = [];

    for (let learning of learnings) {
      learning = applyDecay(learning);
      learning = updateLearningText(learning);

      if (learning.score > 0.8) {
        toPromote.push(learning);
      } else if (learning.score < 0.2) {
        toArchive.push(learning);
      } else {
        toKeep.push(learning);
      }
    }

    // Promote high scorers
    for (const learning of toPromote) {
      const filepath = promoteLearning(learning);
      result.details.push({
        action: 'promoted',
        id: learning.id,
        score: learning.score,
        filepath,
      });
    }

    // Archive low scorers
    for (const learning of toArchive) {
      const filepath = archiveLearning(learning);
      result.details.push({
        action: 'archived',
        id: learning.id,
        score: learning.score,
        filepath,
      });
    }

    // Write back active learnings
    writeLearningsFile(learningsFile, toKeep);

    result.swept = learnings.length;
    result.promoted = toPromote.length;
    result.archived = toArchive.length;
    result.active = toKeep.length;

  } else if (args.update) {
    const id = args.update as string;
    const resultType = args.result as string;

    if (!resultType || (resultType !== 'win' && resultType !== 'loss')) {
      console.error('Error: --result must be "win" or "loss"');
      process.exit(1);
    }

    let found = false;
    learnings = learnings.map(l => {
      if (l.id === id) {
        found = true;
        const updated = updateScore(l, resultType as 'win' | 'loss');
        const withText = updateLearningText(updated);
        result.details.push({
          action: 'updated',
          id: withText.id,
          oldScore: l.score,
          newScore: withText.score,
          result: resultType,
        });
        return withText;
      }
      return l;
    });

    if (!found) {
      console.error(`Error: Learning ${id} not found`);
      process.exit(1);
    }

    writeLearningsFile(learningsFile, learnings);

  } else if (args.boost) {
    const id = args.boost as string;

    let found = false;
    learnings = learnings.map(l => {
      if (l.id === id) {
        found = true;
        const boosted = boostScore(l);
        const withText = updateLearningText(boosted);
        result.details.push({
          action: 'boosted',
          id: withText.id,
          oldScore: l.score,
          newScore: withText.score,
        });
        return withText;
      }
      return l;
    });

    if (!found) {
      console.error(`Error: Learning ${id} not found`);
      process.exit(1);
    }

    writeLearningsFile(learningsFile, learnings);

  } else {
    console.error('Error: Must specify --sweep, --update, or --boost');
    showHelp();
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main();
