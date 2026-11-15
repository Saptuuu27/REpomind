import { ThinkingLevel } from '@google/genai';
import type { GeneratedDocs, RepositoryRecord } from '../src/types.ts';
import {
  formatAiError,
  generateAiText,
  getPrimaryAiTextModel,
  isAiTextConfigured,
} from './ai.ts';

export async function generateRepositoryDocs(repo: RepositoryRecord): Promise<GeneratedDocs> {
  if (!isAiTextConfigured()) {
    return {
      status: 'error',
      model: getPrimaryAiTextModel(),
      generatedAt: new Date().toISOString(),
      markdown: '',
      sectionsIncluded: [],
      errorMessage:
        'No AI text provider is configured. Configure GROQ_API_KEY or GEMINI_API_KEY in server secrets to generate documentation.',
    };
  }

  try {
    const manifestFiles = repo.files.filter((f) =>
      [
        'package.json',
        'pyproject.toml',
        'requirements.txt',
        'Cargo.toml',
        'go.mod',
        'Dockerfile',
        '.env.example',
        'tsconfig.json',
      ].includes(f.name)
    );

    const manifestText = manifestFiles
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 3000)}\n\`\`\``)
      .join('\n\n');

    const entrySet = new Set(repo.detectedFacts.entryPoints.map((e) => e.path));
    const entryFiles = repo.files
      .filter((f) => entrySet.has(f.path))
      .slice(0, 6)
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content.slice(0, 2200)}\n\`\`\``)
      .join('\n\n');

    const modulesSummary =
      repo.aiAnalysis.modules.length > 0
        ? repo.aiAnalysis.modules
            .map((m) => `- **${m.name}** (\`${m.directoryOrFile}\`): ${m.responsibility}`)
            .join('\n')
        : repo.files
            .slice(0, 35)
            .map((f) => `- \`${f.path}\` (${f.language}, ${f.lines} lines)`)
            .join('\n');

    const scriptsSummary = repo.detectedFacts.packageManifest?.scripts
      ? Object.entries(repo.detectedFacts.packageManifest.scripts)
          .map(([k, v]) => `- \`${k}\`: \`${v}\``)
          .join('\n')
      : 'No npm scripts detected.';

    const prompt = `Generate clean, production-grade developer documentation in Markdown for the repository **${repo.metadata.fullName}**.

REPOSITORY METADATA:
- URL: ${repo.metadata.htmlUrl}
- Default Branch: ${repo.metadata.defaultBranch}
- Description: ${repo.metadata.description ?? 'Not specified'}
- License: ${repo.metadata.license ?? 'Not specified'}

DETECTED STACK & FACTS:
- Languages: ${repo.detectedFacts.languages.map((l) => `${l.language} (${l.percentage}%)`).join(', ')}
- Frameworks & Tools: ${repo.detectedFacts.frameworks.map((fw) => `${fw.name} (${fw.evidenceFile})`).join(', ') || 'None detected'}
- Entry Points: ${repo.detectedFacts.entryPoints.map((e) => e.path).join(', ') || 'Not explicitly declared'}
- Package Scripts:
${scriptsSummary}

DETECTED MODULES:
${modulesSummary}

ARCHITECTURE EDGES DETECTED:
${repo.architecture.internalEdgeCount} internal module imports across ${repo.architecture.parsedFilesCount} parsed source files.

MANIFEST & CONFIG FILES:
${manifestText || '(No manifest files ingested)'}

ENTRY POINT EXCERPTS:
${entryFiles || '(No entry point excerpts)'}

README EXCERPT:
${repo.readmeContent ? repo.readmeContent.slice(0, 3500) : '(No README found)'}

REQUIRED MARKDOWN STRUCTURE:
1. # ${repo.metadata.name} — Technical Documentation
2. ## Project Summary
3. ## Tech Stack & Detected Dependencies (cite actual manifest files)
4. ## Module Reference (explain actual modules and real file paths)
5. ## Setup & Local Development (strictly based on observed package.json/Dockerfile/requirements/README; if setup steps or env vars are not specified in ingested files, explicitly state that instead of inventing commands)
6. ## Architecture Notes (summarize detected internal dependencies)`;

    const aiRes = await generateAiText({
      systemInstruction:
        'You are a staff technical writer creating accurate developer documentation. Ground every file path, command, script, dependency, and environment variable strictly in the provided repository files. Never invent installation commands, ports, or environment variables that do not appear in the provided manifests or README.',
      prompt,
      thinkingLevel: ThinkingLevel.LOW,
      maxTokens: 6144,
    });

    return {
      status: 'complete',
      model: aiRes.model,
      generatedAt: new Date().toISOString(),
      markdown: aiRes.text,
      sectionsIncluded: [
        'Project Summary',
        'Tech Stack & Detected Dependencies',
        'Module Reference',
        'Setup & Local Development',
        'Architecture Notes',
      ],
    };
  } catch (err) {
    return {
      status: 'error',
      model: getPrimaryAiTextModel(),
      generatedAt: new Date().toISOString(),
      markdown: '',
      sectionsIncluded: [],
      errorMessage: formatAiError(err),
    };
  }
}
