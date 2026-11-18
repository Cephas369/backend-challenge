/** Tokens de injeção da infraestrutura (evitam acoplar consumidores a classes concretas). */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const LOGGER = Symbol('LOGGER');
export const MIKRO_ORM = Symbol('MIKRO_ORM');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
