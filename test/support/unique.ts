/** Sufixo curto e único por execução, válido em nomes de banco e de fila. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`variável de ambiente ${name} ausente`);
  }
  return value;
}
