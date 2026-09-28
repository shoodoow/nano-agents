CREATE TABLE "provider_keys" (
	"account_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"secret" text NOT NULL,
	"base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_keys_account_id_provider_pk" PRIMARY KEY("account_id","provider"),
	CONSTRAINT "provider_keys_provider_check" CHECK ("provider" in ('openai', 'anthropic', 'xai', 'local')),
	CONSTRAINT "provider_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action
);
