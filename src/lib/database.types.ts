export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      blocks: {
        Row: {
          blocked_id: string
          blocker_id: string
          created_at: string
        }
        Insert: {
          blocked_id: string
          blocker_id: string
          created_at?: string
        }
        Update: {
          blocked_id?: string
          blocker_id?: string
          created_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "blocks_blocked_id_fkey"
            columns: ["blocked_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "blocks_blocker_id_fkey"
            columns: ["blocker_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_comment_reactions: {
        Row: {
          chat_id: string
          comment_id: string
          created_at: string
          emoji: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_id: string
          comment_id: string
          created_at?: string
          emoji: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_id?: string
          comment_id?: string
          created_at?: string
          emoji?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_comment_reactions_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "title_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_comment_reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "chat_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_comment_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_comments: {
        Row: {
          body: string
          chat_id: string
          created_at: string
          id: string
          user_id: string | null
        }
        Insert: {
          body: string
          chat_id: string
          created_at?: string
          id?: string
          user_id?: string | null
        }
        Update: {
          body?: string
          chat_id?: string
          created_at?: string
          id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chat_comments_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "title_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      chat_reactions: {
        Row: {
          chat_id: string
          created_at: string
          emoji: string
          updated_at: string
          user_id: string
        }
        Insert: {
          chat_id: string
          created_at?: string
          emoji: string
          updated_at?: string
          user_id: string
        }
        Update: {
          chat_id?: string
          created_at?: string
          emoji?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "chat_reactions_chat_id_fkey"
            columns: ["chat_id"]
            isOneToOne: false
            referencedRelation: "title_chats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chat_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      favorites: {
        Row: {
          created_at: string
          id: string
          media_type: string
          rank: number
          tmdb_id: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          media_type: string
          rank: number
          tmdb_id: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          media_type?: string
          rank?: number
          tmdb_id?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "favorites_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback: {
        Row: {
          app_version: string | null
          body: string
          created_at: string
          device: string | null
          id: string
          reply_email: string | null
          screenshot_path: string | null
          status: string
          user_id: string | null
        }
        Insert: {
          app_version?: string | null
          body: string
          created_at?: string
          device?: string | null
          id?: string
          reply_email?: string | null
          screenshot_path?: string | null
          status?: string
          user_id?: string | null
        }
        Update: {
          app_version?: string | null
          body?: string
          created_at?: string
          device?: string | null
          id?: string
          reply_email?: string | null
          screenshot_path?: string | null
          status?: string
          user_id?: string | null
        }
        Relationships: []
      }
      friend_requests: {
        Row: {
          created_at: string
          from_user_id: string
          id: string
          to_user_id: string
        }
        Insert: {
          created_at?: string
          from_user_id: string
          id?: string
          to_user_id: string
        }
        Update: {
          created_at?: string
          from_user_id?: string
          id?: string
          to_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "friend_requests_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friend_requests_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      friendships: {
        Row: {
          created_at: string
          user_a_id: string
          user_b_id: string
        }
        Insert: {
          created_at?: string
          user_a_id: string
          user_b_id: string
        }
        Update: {
          created_at?: string
          user_a_id?: string
          user_b_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "friendships_user_a_id_fkey"
            columns: ["user_a_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "friendships_user_b_id_fkey"
            columns: ["user_b_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      handle_history: {
        Row: {
          available_at: string
          handle: string
          released_at: string
        }
        Insert: {
          available_at?: string
          handle: string
          released_at: string
        }
        Update: {
          available_at?: string
          handle?: string
          released_at?: string
        }
        Relationships: []
      }
      invite_links: {
        Row: {
          created_at: string
          revoked_at: string | null
          token: string
          user_id: string
        }
        Insert: {
          created_at?: string
          revoked_at?: string | null
          token: string
          user_id: string
        }
        Update: {
          created_at?: string
          revoked_at?: string | null
          token?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "invite_links_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      items: {
        Row: {
          created_at: string
          id: string
          media_type: string
          note: string | null
          progress_episode: number | null
          progress_season: number | null
          rating: number | null
          status: string
          tmdb_id: number
          updated_at: string
          user_id: string
          visibility: string
          watched_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          media_type: string
          note?: string | null
          progress_episode?: number | null
          progress_season?: number | null
          rating?: number | null
          status: string
          tmdb_id: number
          updated_at?: string
          user_id: string
          visibility?: string
          watched_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          media_type?: string
          note?: string | null
          progress_episode?: number | null
          progress_season?: number | null
          rating?: number | null
          status?: string
          tmdb_id?: number
          updated_at?: string
          user_id?: string
          visibility?: string
          watched_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "items_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          kind: string
          payload: Json
          read_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          payload?: Json
          read_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          payload?: Json
          read_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_recommendations: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          from_user_id: string
          id: string
          media_type: string
          note: string | null
          tmdb_id: number
          token: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          from_user_id: string
          id?: string
          media_type: string
          note?: string | null
          tmdb_id: number
          token?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          from_user_id?: string
          id?: string
          media_type?: string
          note?: string | null
          tmdb_id?: number
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "pending_recommendations_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pending_recommendations_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          deleted_at: string | null
          display_name: string
          handle: string
          handle_changed_at: string | null
          id: string
          onboarded: boolean
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name: string
          handle: string
          handle_changed_at?: string | null
          id: string
          onboarded?: boolean
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string
          handle?: string
          handle_changed_at?: string | null
          id?: string
          onboarded?: boolean
        }
        Relationships: []
      }
      push_tokens: {
        Row: {
          created_at: string
          device_id: string
          expo_push_token: string
          id: string
          last_seen_at: string
          platform: string
          user_id: string
        }
        Insert: {
          created_at?: string
          device_id: string
          expo_push_token: string
          id?: string
          last_seen_at?: string
          platform: string
          user_id: string
        }
        Update: {
          created_at?: string
          device_id?: string
          expo_push_token?: string
          id?: string
          last_seen_at?: string
          platform?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_tokens_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      recommendation_comment_reactions: {
        Row: {
          comment_id: string
          created_at: string
          emoji: string
          recommendation_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          comment_id: string
          created_at?: string
          emoji: string
          recommendation_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          comment_id?: string
          created_at?: string
          emoji?: string
          recommendation_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_comment_reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "recommendation_comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_comment_reactions_recommendation_id_fkey"
            columns: ["recommendation_id"]
            isOneToOne: false
            referencedRelation: "recommendations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_comment_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      recommendation_comments: {
        Row: {
          body: string
          created_at: string
          from_watched: boolean
          id: string
          is_decline_note: boolean
          recommendation_id: string
          user_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          from_watched?: boolean
          id?: string
          is_decline_note?: boolean
          recommendation_id: string
          user_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          from_watched?: boolean
          id?: string
          is_decline_note?: boolean
          recommendation_id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_comments_recommendation_id_fkey"
            columns: ["recommendation_id"]
            isOneToOne: false
            referencedRelation: "recommendations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_comments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      recommendation_reactions: {
        Row: {
          created_at: string
          emoji: string
          recommendation_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          emoji: string
          recommendation_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          emoji?: string
          recommendation_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "recommendation_reactions_recommendation_id_fkey"
            columns: ["recommendation_id"]
            isOneToOne: false
            referencedRelation: "recommendations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendation_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      recommendations: {
        Row: {
          dismiss_reason: string | null
          from_user_id: string | null
          hidden_from_home: boolean
          id: string
          media_type: string
          note: string | null
          rating_thumb: string | null
          resolved_at: string | null
          sent_at: string
          status: string
          tmdb_id: number
          to_user_id: string
          watched_via_rec: boolean
        }
        Insert: {
          dismiss_reason?: string | null
          from_user_id?: string | null
          hidden_from_home?: boolean
          id?: string
          media_type: string
          note?: string | null
          rating_thumb?: string | null
          resolved_at?: string | null
          sent_at?: string
          status?: string
          tmdb_id: number
          to_user_id: string
          watched_via_rec?: boolean
        }
        Update: {
          dismiss_reason?: string | null
          from_user_id?: string | null
          hidden_from_home?: boolean
          id?: string
          media_type?: string
          note?: string | null
          rating_thumb?: string | null
          resolved_at?: string | null
          sent_at?: string
          status?: string
          tmdb_id?: number
          to_user_id?: string
          watched_via_rec?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "recommendations_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recommendations_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reports: {
        Row: {
          created_at: string
          id: string
          reason: string | null
          reported_id: string
          reported_type: string
          reported_user_id: string | null
          reporter_id: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          reason?: string | null
          reported_id: string
          reported_type: string
          reported_user_id?: string | null
          reporter_id?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          reason?: string | null
          reported_id?: string
          reported_type?: string
          reported_user_id?: string | null
          reporter_id?: string | null
          status?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          body: string
          contains_spoilers: boolean
          created_at: string
          id: string
          media_type: string
          tmdb_id: number
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          contains_spoilers?: boolean
          created_at?: string
          id?: string
          media_type: string
          tmdb_id: number
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          contains_spoilers?: boolean
          created_at?: string
          id?: string
          media_type?: string
          tmdb_id?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reviews_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      title_chats: {
        Row: {
          created_at: string
          episode: number | null
          from_user_id: string
          id: string
          media_type: string
          season: number | null
          tmdb_id: number
          to_user_id: string
        }
        Insert: {
          created_at?: string
          episode?: number | null
          from_user_id: string
          id?: string
          media_type: string
          season?: number | null
          tmdb_id: number
          to_user_id: string
        }
        Update: {
          created_at?: string
          episode?: number | null
          from_user_id?: string
          id?: string
          media_type?: string
          season?: number | null
          tmdb_id?: number
          to_user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "title_chats_from_user_id_fkey"
            columns: ["from_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "title_chats_to_user_id_fkey"
            columns: ["to_user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      titles: {
        Row: {
          backdrop_path: string | null
          created_at: string
          genre_ids: number[] | null
          media_type: string
          original_language: string | null
          poster_path: string | null
          release_date: string | null
          title: string | null
          tmdb_id: number
          updated_at: string
        }
        Insert: {
          backdrop_path?: string | null
          created_at?: string
          genre_ids?: number[] | null
          media_type: string
          original_language?: string | null
          poster_path?: string | null
          release_date?: string | null
          title?: string | null
          tmdb_id: number
          updated_at?: string
        }
        Update: {
          backdrop_path?: string | null
          created_at?: string
          genre_ids?: number[] | null
          media_type?: string
          original_language?: string | null
          poster_path?: string | null
          release_date?: string | null
          title?: string | null
          tmdb_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      waitlist: {
        Row: {
          created_at: string
          email: string
          id: string
          source: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          source?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          source?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_friend_request: {
        Args: { request_id: string }
        Returns: undefined
      }
      block_user: { Args: { other_user_id: string }; Returns: undefined }
      can_send_friend_request: { Args: { target: string }; Returns: boolean }
      claim_invite_link: { Args: { token: string }; Returns: string }
      claim_pending_recommendation: {
        Args: { p_token: string }
        Returns: string
      }
      decline_friend_request: {
        Args: { request_id: string }
        Returns: undefined
      }
      delete_account_data: { Args: { p_uid: string }; Returns: undefined }
      ensure_title: {
        Args: {
          p_backdrop_path: string
          p_genre_ids: number[]
          p_media_type: string
          p_original_language: string
          p_poster_path: string
          p_release_date: string
          p_title: string
          p_tmdb_id: number
        }
        Returns: undefined
      }
      generate_invite_token: { Args: never; Returns: string }
      get_friends_activity: {
        Args: never
        Returns: {
          activity_at: string
          friend_id: string
          media_type: string
          rating: number
          status: string
          title_name: string
          tmdb_id: number
        }[]
      }
      is_blocked_pair: { Args: { a: string; b: string }; Returns: boolean }
      is_blocked_with_auth: { Args: { other: string }; Returns: boolean }
      is_friend_of_auth: { Args: { other_user: string }; Returns: boolean }
      is_item_visible_to_auth: {
        Args: { item_user_id: string; item_visibility: string }
        Returns: boolean
      }
      is_party_to_chat: { Args: { chat_id: string }; Returns: boolean }
      is_party_to_chat_comment: {
        Args: { comment_id: string }
        Returns: boolean
      }
      is_party_to_chat_comment_unblocked: {
        Args: { comment_id: string }
        Returns: boolean
      }
      is_party_to_chat_unblocked: {
        Args: { chat_id: string }
        Returns: boolean
      }
      is_party_to_comment: { Args: { comment_id: string }; Returns: boolean }
      is_party_to_comment_unblocked: {
        Args: { comment_id: string }
        Returns: boolean
      }
      is_party_to_rec: { Args: { rec_id: string }; Returns: boolean }
      is_party_to_rec_unblocked: { Args: { rec_id: string }; Returns: boolean }
      is_recipient_of_rec: { Args: { rec_id: string }; Returns: boolean }
      list_blocked_users: {
        Args: never
        Returns: {
          avatar_url: string
          blocked_at: string
          display_name: string
          handle: string
          user_id: string
        }[]
      }
      mark_recommendation_watched: {
        Args: { p_rec_id: string; p_suppress?: boolean; p_thumb?: string }
        Returns: undefined
      }
      reorder_favorites: {
        Args: { p_media_type: string; p_ordered_ids: string[] }
        Returns: undefined
      }
      request_recommendation: {
        Args: { note?: string; to_user_id: string }
        Returns: undefined
      }
      send_recommendation: {
        Args: {
          media_type: string
          note?: string
          tmdb_id: number
          to_user_id: string
        }
        Returns: string
      }
      unblock_user: { Args: { other_user_id: string }; Returns: undefined }
      unfriend: { Args: { other_user_id: string }; Returns: undefined }
      unread_count: { Args: { p_uid: string }; Returns: number }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
