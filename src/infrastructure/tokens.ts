/** Tokens de injeção da infraestrutura (evitam acoplar consumidores a classes concretas). */
export const APP_CONFIG = Symbol('APP_CONFIG');
export const LOGGER = Symbol('LOGGER');
export const MIKRO_ORM = Symbol('MIKRO_ORM');
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');
export const CLOCK = Symbol('CLOCK');
export const ID_GENERATOR = Symbol('ID_GENERATOR');
export const SQS_CLIENT = Symbol('SQS_CLIENT');
