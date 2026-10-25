CREATE TABLE "person_recipe_feedback" (
	"person_id" integer NOT NULL,
	"recipe_id" integer NOT NULL,
	"rating" integer,
	"favourite" boolean DEFAULT false NOT NULL,
	"uid" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by_person_id" integer,
	CONSTRAINT "person_recipe_feedback_person_id_recipe_id_pk" PRIMARY KEY("person_id","recipe_id"),
	CONSTRAINT "person_recipe_feedback_rating_ck" CHECK ("person_recipe_feedback"."rating" is null or "person_recipe_feedback"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "person_recipe_feedback" ADD CONSTRAINT "person_recipe_feedback_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_recipe_feedback" ADD CONSTRAINT "person_recipe_feedback_recipe_id_recipes_id_fk" FOREIGN KEY ("recipe_id") REFERENCES "public"."recipes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_recipe_feedback" ADD CONSTRAINT "person_recipe_feedback_created_by_person_id_people_id_fk" FOREIGN KEY ("created_by_person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_recipe_feedback_uid_uq" ON "person_recipe_feedback" USING btree ("uid");