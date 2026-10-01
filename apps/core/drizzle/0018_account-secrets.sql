-- Vault secrets for secret widgets. Sealed values, upserted per
-- (account, name); no read path — bots that ask can never see them.
CREATE TABLE IF NOT EXISTS "account_secrets" (
	"account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"secret" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_secrets_account_id_name_pk" PRIMARY KEY("account_id","name"),
	CONSTRAINT "account_secrets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action
);
