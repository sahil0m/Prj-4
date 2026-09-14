CREATE TABLE "audience_questions" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"session_id" varchar(24) NOT NULL,
	"participant_id" varchar(24) NOT NULL,
	"body" varchar(500) NOT NULL,
	"author_name" varchar(60) DEFAULT '' NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"status" varchar(16) DEFAULT 'approved' NOT NULL,
	"pinned_at" timestamp with time zone,
	"client_msg_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "audience_questions_status_check" CHECK ("audience_questions"."status" IN ('pending', 'approved', 'rejected', 'answered'))
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"owner_id" varchar(24) NOT NULL,
	"title" varchar(200) DEFAULT 'Untitled' NOT NULL,
	"description" varchar(1000) DEFAULT '' NOT NULL,
	"slides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{"preset":"midnight","accent":"#6366f1","background":"","fontFamily":"","logoUrl":"","mode":"dark"}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{"mode":"presenter_paced","collectNames":false,"showResultsToParticipants":false,"profanityFilter":true,"reactions":true,"chat":false,"oneAnswerPerDevice":true}'::jsonb NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decks_slides_is_array_check" CHECK (jsonb_typeof("decks"."slides") = 'array')
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"session_id" varchar(24) NOT NULL,
	"device_token" varchar(64) NOT NULL,
	"display_name" varchar(60) DEFAULT '' NOT NULL,
	"user_id" varchar(24),
	"locale" varchar(16) DEFAULT 'en' NOT NULL,
	"score" double precision DEFAULT 0 NOT NULL,
	"current_slide_id" varchar(64),
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"blocked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"user_id" varchar(24) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"family" varchar(64) NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(32),
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" varchar(300) DEFAULT '' NOT NULL,
	"ip_hash" varchar(64) DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_revoked_reason_check" CHECK ("refresh_tokens"."revoked_reason" IS NULL OR "refresh_tokens"."revoked_reason" IN ('rotated', 'logout', 'logout_all', 'reuse_detected', 'password_changed'))
);
--> statement-breakpoint
CREATE TABLE "responses" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"session_id" varchar(24) NOT NULL,
	"slide_id" varchar(64) NOT NULL,
	"participant_id" varchar(24) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"payload" jsonb NOT NULL,
	"client_msg_id" varchar(64) NOT NULL,
	"is_correct" boolean,
	"points" double precision,
	"elapsed_ms" double precision,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_reason" varchar(16),
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responses_deleted_reason_check" CHECK ("responses"."deleted_reason" IS NULL OR "responses"."deleted_reason" IN ('presenter', 'profanity', 'moderation'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"deck_id" varchar(24),
	"owner_id" varchar(24) NOT NULL,
	"title" varchar(200) NOT NULL,
	"join_code" varchar(12) NOT NULL,
	"join_slug" varchar(32) NOT NULL,
	"state" varchar(16) DEFAULT 'live' NOT NULL,
	"mode" varchar(24) NOT NULL,
	"deck_snapshot" jsonb NOT NULL,
	"current_slide_id" varchar(64),
	"participation_open" boolean DEFAULT true NOT NULL,
	"results_visible" boolean DEFAULT true NOT NULL,
	"countdown_started_at" timestamp with time zone,
	"countdown_slide_id" varchar(64),
	"participant_count" integer DEFAULT 0 NOT NULL,
	"response_count" integer DEFAULT 0 NOT NULL,
	"peak_concurrent" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"retention_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_state_check" CHECK ("sessions"."state" IN ('scheduled', 'live', 'paused', 'closed')),
	CONSTRAINT "sessions_mode_check" CHECK ("sessions"."mode" IN ('presenter_paced', 'audience_paced'))
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"provider" varchar(32) NOT NULL,
	"subject" varchar(128) NOT NULL,
	"user_id" varchar(24) NOT NULL,
	"email" varchar(320) DEFAULT '' NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_identities_pkey" PRIMARY KEY("provider","subject"),
	CONSTRAINT "user_identities_provider_check" CHECK ("user_identities"."provider" IN ('google'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(24) PRIMARY KEY NOT NULL,
	"email" varchar(320) NOT NULL,
	"password_hash" text,
	"has_password" boolean GENERATED ALWAYS AS (password_hash IS NOT NULL) STORED NOT NULL,
	"name" varchar(100) NOT NULL,
	"avatar_url" varchar(2000) DEFAULT '' NOT NULL,
	"locale" varchar(16) DEFAULT 'en' NOT NULL,
	"email_verified_at" timestamp with time zone,
	"token_version" integer DEFAULT 0 NOT NULL,
	"role" varchar(16) DEFAULT 'user' NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspended_reason" varchar(300) DEFAULT '' NOT NULL,
	"ai_requests_today" integer DEFAULT 0 NOT NULL,
	"ai_requests_reset_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('user', 'admin')),
	CONSTRAINT "users_email_lowercase_check" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "audience_questions" ADD CONSTRAINT "audience_questions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_questions" ADD CONSTRAINT "audience_questions_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responses" ADD CONSTRAINT "responses_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audience_questions_session_client_msg_key" ON "audience_questions" USING btree ("session_id","client_msg_id");--> statement-breakpoint
CREATE INDEX "audience_questions_queue_idx" ON "audience_questions" USING btree ("session_id","status","upvotes" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "decks_owner_listing_idx" ON "decks" USING btree ("owner_id","deleted_at","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "decks_deleted_at_idx" ON "decks" USING btree ("deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_session_device_key" ON "participants" USING btree ("session_id","device_token");--> statement-breakpoint
CREATE INDEX "participants_leaderboard_idx" ON "participants" USING btree ("session_id","score" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family","revoked_at");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id","revoked_at","expires_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "responses_session_client_msg_key" ON "responses" USING btree ("session_id","client_msg_id");--> statement-breakpoint
CREATE INDEX "responses_slide_live_idx" ON "responses" USING btree ("session_id","slide_id","submitted_at") WHERE "responses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "responses_participant_idx" ON "responses" USING btree ("session_id","participant_id","slide_id");--> statement-breakpoint
CREATE INDEX "responses_scored_idx" ON "responses" USING btree ("session_id","participant_id") WHERE "responses"."points" IS NOT NULL AND "responses"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "responses_submitted_at_idx" ON "responses" USING btree ("submitted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_live_join_code_key" ON "sessions" USING btree ("join_code") WHERE "sessions"."state" IN ('scheduled', 'live', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_join_slug_key" ON "sessions" USING btree ("join_slug");--> statement-breakpoint
CREATE INDEX "sessions_deck_idx" ON "sessions" USING btree ("deck_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_owner_idx" ON "sessions" USING btree ("owner_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sessions_state_idx" ON "sessions" USING btree ("state");--> statement-breakpoint
CREATE INDEX "user_identities_user_id_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_deleted_at_idx" ON "users" USING btree ("deleted_at");