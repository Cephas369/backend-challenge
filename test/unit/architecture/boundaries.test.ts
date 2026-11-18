import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { Glob } from 'bun';

const SOURCE_ROOT = path.resolve(import.meta.dir, '../../../src');

type Layer = 'domain' | 'application' | 'infrastructure' | 'interfaces';

/**
 * Regra de dependência: o domínio é TypeScript puro e a aplicação só conhece portas.
 * Framework, ORM, SDK e camadas externas ficam em infrastructure/interfaces.
 */
const FORBIDDEN: Record<'domain' | 'application', { layers: Layer[]; packages: RegExp }> = {
  domain: {
    layers: ['application', 'infrastructure', 'interfaces'],
    packages: /^(@nestjs|@mikro-orm|@aws-sdk|pino|zod|express)(\/|$)/,
  },
  application: {
    layers: ['infrastructure', 'interfaces'],
    packages: /^(@nestjs|@mikro-orm|@aws-sdk|pino|zod|express)(\/|$)/,
  },
};

const IMPORT_SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importsOf(source: string): string[] {
  const found: { index: number; specifier: string }[] = [];
  for (const pattern of IMPORT_SPECIFIERS) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) {
        found.push({ index: match.index, specifier: match[1] });
      }
    }
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.specifier);
}

function layerOf(absolutePath: string): Layer | undefined {
  const [first] = path.relative(SOURCE_ROOT, absolutePath).split(path.sep);
  return first === 'domain' || first === 'application' || first === 'infrastructure' || first === 'interfaces'
    ? first
    : undefined;
}

function violationsIn(file: string, source: string): string[] {
  const layer = layerOf(file);
  if (layer !== 'domain' && layer !== 'application') {
    return [];
  }
  const rule = FORBIDDEN[layer];
  const shown = path.relative(path.dirname(SOURCE_ROOT), file);
  return importsOf(source).flatMap((specifier) => {
    if (specifier.startsWith('.')) {
      const target = layerOf(path.resolve(path.dirname(file), specifier));
      return target !== undefined && rule.layers.includes(target)
        ? [`${shown} → ${specifier} (camada ${target})`]
        : [];
    }
    return rule.packages.test(specifier) ? [`${shown} → ${specifier}`] : [];
  });
}

describe('fronteiras entre camadas', () => {
  test('domain e application não dependem de framework, ORM, SDK nem de camadas externas', async () => {
    const files = await Array.fromAsync(
      new Glob('{domain,application}/**/*.ts').scan({ cwd: SOURCE_ROOT, absolute: true }),
    );
    const violations = await Promise.all(
      files.map(async (file) => violationsIn(file, await Bun.file(file).text())),
    );

    expect(violations.flat()).toEqual([]);
  });

  test('a regra detecta imports proibidos, inclusive os só de tipo', () => {
    const file = path.join(SOURCE_ROOT, 'domain', 'wallet', 'wallet.ts');
    const source = [
      "import { Injectable } from '@nestjs/common';",
      "import { WalletRecord } from '../../infrastructure/persistence/wallet.record';",
      "import { Money } from '../money/money';",
      'import type { EntityManager } from "@mikro-orm/core";',
    ].join('\n');

    expect(violationsIn(file, source)).toEqual([
      'src/domain/wallet/wallet.ts → @nestjs/common',
      'src/domain/wallet/wallet.ts → ../../infrastructure/persistence/wallet.record (camada infrastructure)',
      'src/domain/wallet/wallet.ts → @mikro-orm/core',
    ]);
  });
});
