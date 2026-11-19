-- Usuário de login da aplicação. Herda apenas os privilégios de wagering_runtime (criado pela
-- migration): lê e insere no ledger, mas não altera nem apaga. As migrations rodam com o dono.
do $$
begin
  create role wagering_app login password 'wagering_app' in role wagering_runtime;
exception when duplicate_object then
  null;
end
$$;
