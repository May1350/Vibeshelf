export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5";
  };
  graphql_public: {
    Tables: {
      [_ in never]: never;
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      graphql: {
        Args: {
          extensions?: Json;
          operationName?: string;
          query?: string;
          variables?: Json;
        };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
  public: {
    Tables: {
      fork_events: {
        Row: {
          forked_at: string;
          github_fork_id: number;
          github_fork_url: string;
          id: string;
          repo_id: string;
          user_id: string;
        };
        Insert: {
          forked_at?: string;
          github_fork_id: number;
          github_fork_url: string;
          id?: string;
          repo_id: string;
          user_id: string;
        };
        Update: {
          forked_at?: string;
          github_fork_id?: number;
          github_fork_url?: string;
          id?: string;
          repo_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "fork_events_repo_id_fkey";
            columns: ["repo_id"];
            isOneToOne: false;
            referencedRelation: "repos";
            referencedColumns: ["id"];
          },
        ];
      };
      github_oauth_tokens: {
        Row: {
          created_at: string;
          last_validated_at: string | null;
          revoked_at: string | null;
          scopes: string[];
          token_encrypted: string;
          token_key_version: number;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          last_validated_at?: string | null;
          revoked_at?: string | null;
          scopes: string[];
          token_encrypted: string;
          token_key_version: number;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          last_validated_at?: string | null;
          revoked_at?: string | null;
          scopes?: string[];
          token_encrypted?: string;
          token_key_version?: number;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      github_tokens: {
        Row: {
          created_at: string;
          disabled_at: string | null;
          id: string;
          label: string;
          last_used_at: string | null;
          remaining: number | null;
          reset_at: string | null;
          scope: string;
          token_encrypted: string;
          token_key_version: number;
        };
        Insert: {
          created_at?: string;
          disabled_at?: string | null;
          id?: string;
          label: string;
          last_used_at?: string | null;
          remaining?: number | null;
          reset_at?: string | null;
          scope: string;
          token_encrypted: string;
          token_key_version: number;
        };
        Update: {
          created_at?: string;
          disabled_at?: string | null;
          id?: string;
          label?: string;
          last_used_at?: string | null;
          remaining?: number | null;
          reset_at?: string | null;
          scope?: string;
          token_encrypted?: string;
          token_key_version?: number;
        };
        Relationships: [];
      };
      pipeline_runs: {
        Row: {
          error_message: string | null;
          error_stack: string | null;
          finished_at: string | null;
          id: string;
          input: Json | null;
          job_name: string;
          metrics: Json | null;
          parent_run_id: string | null;
          started_at: string;
          status: Database["public"]["Enums"]["pipeline_run_status"];
          trace_id: string | null;
        };
        Insert: {
          error_message?: string | null;
          error_stack?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json | null;
          job_name: string;
          metrics?: Json | null;
          parent_run_id?: string | null;
          started_at?: string;
          status?: Database["public"]["Enums"]["pipeline_run_status"];
          trace_id?: string | null;
        };
        Update: {
          error_message?: string | null;
          error_stack?: string | null;
          finished_at?: string | null;
          id?: string;
          input?: Json | null;
          job_name?: string;
          metrics?: Json | null;
          parent_run_id?: string | null;
          started_at?: string;
          status?: Database["public"]["Enums"]["pipeline_run_status"];
          trace_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "pipeline_runs_parent_run_id_fkey";
            columns: ["parent_run_id"];
            isOneToOne: false;
            referencedRelation: "pipeline_runs";
            referencedColumns: ["id"];
          },
        ];
      };
      repo_assets: {
        Row: {
          ai_description: string | null;
          content_type: string | null;
          created_at: string;
          external_url: string | null;
          height: number | null;
          id: string;
          kind: Database["public"]["Enums"]["asset_kind"];
          priority: number;
          repo_id: string;
          source_url: string | null;
          storage_key: string | null;
          width: number | null;
        };
        Insert: {
          ai_description?: string | null;
          content_type?: string | null;
          created_at?: string;
          external_url?: string | null;
          height?: number | null;
          id?: string;
          kind: Database["public"]["Enums"]["asset_kind"];
          priority?: number;
          repo_id: string;
          source_url?: string | null;
          storage_key?: string | null;
          width?: number | null;
        };
        Update: {
          ai_description?: string | null;
          content_type?: string | null;
          created_at?: string;
          external_url?: string | null;
          height?: number | null;
          id?: string;
          kind?: Database["public"]["Enums"]["asset_kind"];
          priority?: number;
          repo_id?: string;
          source_url?: string | null;
          storage_key?: string | null;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "repo_assets_repo_id_fkey";
            columns: ["repo_id"];
            isOneToOne: false;
            referencedRelation: "repos";
            referencedColumns: ["id"];
          },
        ];
      };
      repo_scores: {
        Row: {
          code_health_score: number;
          documentation_score: number;
          id: string;
          is_latest: boolean;
          maintenance_score: number;
          popularity_score: number;
          raw_response: Json | null;
          repo_id: string;
          scored_at: string;
          scoring_model: string;
          scoring_prompt_version: string;
          total_score: number;
          vibecoding_compat_score: number;
        };
        Insert: {
          code_health_score: number;
          documentation_score: number;
          id?: string;
          is_latest?: boolean;
          maintenance_score: number;
          popularity_score: number;
          raw_response?: Json | null;
          repo_id: string;
          scored_at?: string;
          scoring_model: string;
          scoring_prompt_version: string;
          total_score: number;
          vibecoding_compat_score: number;
        };
        Update: {
          code_health_score?: number;
          documentation_score?: number;
          id?: string;
          is_latest?: boolean;
          maintenance_score?: number;
          popularity_score?: number;
          raw_response?: Json | null;
          repo_id?: string;
          scored_at?: string;
          scoring_model?: string;
          scoring_prompt_version?: string;
          total_score?: number;
          vibecoding_compat_score?: number;
        };
        Relationships: [
          {
            foreignKeyName: "repo_scores_repo_id_fkey";
            columns: ["repo_id"];
            isOneToOne: false;
            referencedRelation: "repos";
            referencedColumns: ["id"];
          },
        ];
      };
      repo_tags: {
        Row: {
          confidence: number | null;
          created_at: string;
          repo_id: string;
          source: string;
          tag_id: string;
        };
        Insert: {
          confidence?: number | null;
          created_at?: string;
          repo_id: string;
          source: string;
          tag_id: string;
        };
        Update: {
          confidence?: number | null;
          created_at?: string;
          repo_id?: string;
          source?: string;
          tag_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "repo_tags_repo_id_fkey";
            columns: ["repo_id"];
            isOneToOne: false;
            referencedRelation: "repos";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "repo_tags_tag_id_fkey";
            columns: ["tag_id"];
            isOneToOne: false;
            referencedRelation: "tags";
            referencedColumns: ["id"];
          },
        ];
      };
      repos: {
        Row: {
          capabilities: Json;
          category: Database["public"]["Enums"]["repo_category"] | null;
          created_at: string;
          default_branch: string;
          description: string | null;
          forks: number;
          full_name: string | null;
          github_created_at: string;
          github_id: number;
          github_pushed_at: string;
          homepage: string | null;
          id: string;
          last_commit_at: string;
          license: string;
          metadata: Json;
          name: string;
          owner: string;
          readme_sha: string | null;
          stars: number;
          status: Database["public"]["Enums"]["repo_status"];
          supports_brand_matching: boolean;
          updated_at: string;
          watchers: number;
        };
        Insert: {
          capabilities?: Json;
          category?: Database["public"]["Enums"]["repo_category"] | null;
          created_at?: string;
          default_branch?: string;
          description?: string | null;
          forks?: number;
          full_name?: string | null;
          github_created_at: string;
          github_id: number;
          github_pushed_at: string;
          homepage?: string | null;
          id?: string;
          last_commit_at: string;
          license: string;
          metadata?: Json;
          name: string;
          owner: string;
          readme_sha?: string | null;
          stars?: number;
          status?: Database["public"]["Enums"]["repo_status"];
          supports_brand_matching?: boolean;
          updated_at?: string;
          watchers?: number;
        };
        Update: {
          capabilities?: Json;
          category?: Database["public"]["Enums"]["repo_category"] | null;
          created_at?: string;
          default_branch?: string;
          description?: string | null;
          forks?: number;
          full_name?: string | null;
          github_created_at?: string;
          github_id?: number;
          github_pushed_at?: string;
          homepage?: string | null;
          id?: string;
          last_commit_at?: string;
          license?: string;
          metadata?: Json;
          name?: string;
          owner?: string;
          readme_sha?: string | null;
          stars?: number;
          status?: Database["public"]["Enums"]["repo_status"];
          supports_brand_matching?: boolean;
          updated_at?: string;
          watchers?: number;
        };
        Relationships: [];
      };
      review_assets: {
        Row: {
          content_type: string;
          created_at: string;
          height: number | null;
          id: string;
          ordering: number;
          review_id: string;
          storage_key: string;
          width: number | null;
        };
        Insert: {
          content_type: string;
          created_at?: string;
          height?: number | null;
          id?: string;
          ordering: number;
          review_id: string;
          storage_key: string;
          width?: number | null;
        };
        Update: {
          content_type?: string;
          created_at?: string;
          height?: number | null;
          id?: string;
          ordering?: number;
          review_id?: string;
          storage_key?: string;
          width?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: "review_assets_review_id_fkey";
            columns: ["review_id"];
            isOneToOne: false;
            referencedRelation: "reviews";
            referencedColumns: ["id"];
          },
        ];
      };
      reviews: {
        Row: {
          created_at: string;
          id: string;
          rating: number;
          repo_id: string;
          text_body: string | null;
          updated_at: string;
          user_id: string;
          vibecoding_tool: Database["public"]["Enums"]["vibecoding_tool"] | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          rating: number;
          repo_id: string;
          text_body?: string | null;
          updated_at?: string;
          user_id: string;
          vibecoding_tool?: Database["public"]["Enums"]["vibecoding_tool"] | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          rating?: number;
          repo_id?: string;
          text_body?: string | null;
          updated_at?: string;
          user_id?: string;
          vibecoding_tool?: Database["public"]["Enums"]["vibecoding_tool"] | null;
        };
        Relationships: [
          {
            foreignKeyName: "reviews_repo_id_fkey";
            columns: ["repo_id"];
            isOneToOne: false;
            referencedRelation: "repos";
            referencedColumns: ["id"];
          },
        ];
      };
      tags: {
        Row: {
          created_at: string;
          id: string;
          kind: Database["public"]["Enums"]["tag_kind"];
          label: string;
          slug: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          kind: Database["public"]["Enums"]["tag_kind"];
          label: string;
          slug: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          kind?: Database["public"]["Enums"]["tag_kind"];
          label?: string;
          slug?: string;
        };
        Relationships: [];
      };
      user_profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          github_id: number;
          github_username: string;
          id: string;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          github_id: number;
          github_username: string;
          id: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          github_id?: number;
          github_username?: string;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      acquire_github_token: {
        Args: { p_scope: string };
        Returns: {
          id: string;
          token_encrypted: string;
          token_key_version: number;
          remaining: number | null;
          reset_at: string | null;
        }[];
      };
      acquire_pipeline_lock: {
        Args: { lock_key: string };
        Returns: boolean;
      };
      release_pipeline_lock: {
        Args: { lock_key: string };
        Returns: boolean;
      };
      create_review_with_fork_check: {
        Args: {
          p_rating: number;
          p_repo_id: string;
          p_text_body: string;
          p_vibecoding_tool: Database["public"]["Enums"]["vibecoding_tool"];
        };
        Returns: {
          created_at: string;
          id: string;
          rating: number;
          repo_id: string;
          text_body: string | null;
          updated_at: string;
          user_id: string;
          vibecoding_tool: Database["public"]["Enums"]["vibecoding_tool"] | null;
        };
        SetofOptions: {
          from: "*";
          to: "reviews";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_my_oauth_token_encrypted: {
        Args: never;
        Returns: {
          scopes: string[];
          token_encrypted: string;
          token_key_version: number;
        }[];
      };
      mark_oauth_token_revoked: { Args: never; Returns: undefined };
      record_fork_event: {
        Args: {
          p_github_fork_id: number;
          p_github_fork_url: string;
          p_repo_id: string;
        };
        Returns: {
          forked_at: string;
          github_fork_id: number;
          github_fork_url: string;
          id: string;
          repo_id: string;
          user_id: string;
        };
        SetofOptions: {
          from: "*";
          to: "fork_events";
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      upsert_user_oauth_token: {
        Args: {
          p_scopes: string[];
          p_token_encrypted: string;
          p_token_key_version: number;
        };
        Returns: undefined;
      };
    };
    Enums: {
      asset_kind: "readme_gif" | "readme_image" | "demo_screenshot" | "ai_generated";
      pipeline_run_status: "running" | "success" | "failed" | "cancelled";
      repo_category:
        | "saas"
        | "ecommerce"
        | "dashboard"
        | "landing_page"
        | "ai_tool"
        | "utility"
        | "game"
        | "other";
      repo_status: "pending" | "scored" | "published" | "dormant" | "removed";
      tag_kind: "tech_stack" | "vibecoding_tool" | "feature";
      vibecoding_tool: "cursor" | "bolt" | "lovable" | "replit" | "other";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      asset_kind: ["readme_gif", "readme_image", "demo_screenshot", "ai_generated"],
      pipeline_run_status: ["running", "success", "failed", "cancelled"],
      repo_category: [
        "saas",
        "ecommerce",
        "dashboard",
        "landing_page",
        "ai_tool",
        "utility",
        "game",
        "other",
      ],
      repo_status: ["pending", "scored", "published", "dormant", "removed"],
      tag_kind: ["tech_stack", "vibecoding_tool", "feature"],
      vibecoding_tool: ["cursor", "bolt", "lovable", "replit", "other"],
    },
  },
} as const;
