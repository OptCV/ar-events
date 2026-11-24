CREATE TYPE "public"."analytics_event" AS ENUM('view', 'ar_tap', 'link_tap');--> statement-breakpoint
CREATE TABLE "analytics_daily" (
	"experience_id" uuid NOT NULL,
	"day" date NOT NULL,
	"event" "analytics_event" NOT NULL,
	"detail" varchar(40) DEFAULT '' NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_daily_experience_id_day_event_detail_pk" PRIMARY KEY("experience_id","day","event","detail"),
	CONSTRAINT "analytics_daily_count_nonnegative" CHECK ("analytics_daily"."count" >= 0),
	CONSTRAINT "analytics_daily_detail_format" CHECK ("analytics_daily"."detail" ~ '^[a-z_]{0,40}$')
);
--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_experience_id_experiences_id_fk" FOREIGN KEY ("experience_id") REFERENCES "public"."experiences"("id") ON DELETE cascade ON UPDATE no action;