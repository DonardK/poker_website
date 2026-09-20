// Generated 2026-09-20 from MCP generate_typescript_types
// Project: DonardK's Project (gwnaqmbbxfzhgzcfxsvm) — NOT the poker app.
// Do not import this from poker_website application code.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      attendance: {
        Row: {
          company: string
          created_at: string
          date: string
          employee_id: number
          emri: string
          hours_worked: number
          id: number
          location: string
          mbiemri: string
          payment_method: string
        }
        Insert: {
          company?: string
          created_at?: string
          date: string
          employee_id: number
          emri: string
          hours_worked: number
          id?: number
          location?: string
          mbiemri: string
          payment_method: string
        }
        Update: {
          company?: string
          created_at?: string
          date?: string
          employee_id?: number
          emri?: string
          hours_worked?: number
          id?: number
          location?: string
          mbiemri?: string
          payment_method?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_reports: {
        Row: {
          company: string
          content: string
          created_at: string
          date: string
          id: number
          title: string
        }
        Insert: {
          company?: string
          content: string
          created_at?: string
          date: string
          id?: number
          title: string
        }
        Update: {
          company?: string
          content?: string
          created_at?: string
          date?: string
          id?: number
          title?: string
        }
        Relationships: []
      }
      diesel: {
        Row: {
          created_at: string
          date: string
          emri_mjetit: string
          id: number
          liters: number
          photo_base64: string | null
          total_price: number
          vehicle_id: number
        }
        Insert: {
          created_at?: string
          date: string
          emri_mjetit: string
          id?: number
          liters: number
          photo_base64?: string | null
          total_price: number
          vehicle_id: number
        }
        Update: {
          created_at?: string
          date?: string
          emri_mjetit?: string
          id?: number
          liters?: number
          photo_base64?: string | null
          total_price?: number
          vehicle_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "diesel_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      employees: {
        Row: {
          archived_at: string | null
          cmimi_ore: number
          created_at: string
          emri: string
          emri_bankes: string | null
          fixed_salary: number | null
          id: number
          llogaria_bankes: string | null
          mbiemri: string
          payment_method: string
          salary_type: string
        }
        Insert: {
          archived_at?: string | null
          cmimi_ore?: number
          created_at?: string
          emri: string
          emri_bankes?: string | null
          fixed_salary?: number | null
          id?: number
          llogaria_bankes?: string | null
          mbiemri: string
          payment_method: string
          salary_type?: string
        }
        Update: {
          archived_at?: string | null
          cmimi_ore?: number
          created_at?: string
          emri?: string
          emri_bankes?: string | null
          fixed_salary?: number | null
          id?: number
          llogaria_bankes?: string | null
          mbiemri?: string
          payment_method?: string
          salary_type?: string
        }
        Relationships: []
      }
      office_expenses: {
        Row: {
          amount: number
          category: string
          created_at: string | null
          date: string
          id: number
          notes: string | null
          photo_base64: string | null
          title: string
        }
        Insert: {
          amount: number
          category: string
          created_at?: string | null
          date: string
          id?: never
          notes?: string | null
          photo_base64?: string | null
          title: string
        }
        Update: {
          amount?: number
          category?: string
          created_at?: string | null
          date?: string
          id?: never
          notes?: string | null
          photo_base64?: string | null
          title?: string
        }
        Relationships: []
      }
      stock_items: {
        Row: {
          category: string
          created_at: string | null
          id: number
          name: string
          notes: string | null
          quantity: number
          unit: string | null
          updated_at: string | null
        }
        Insert: {
          category: string
          created_at?: string | null
          id?: never
          name: string
          notes?: string | null
          quantity?: number
          unit?: string | null
          updated_at?: string | null
        }
        Update: {
          category?: string
          created_at?: string | null
          id?: never
          name?: string
          notes?: string | null
          quantity?: number
          unit?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      vehicle_services: {
        Row: {
          created_at: string | null
          date: string
          emri_mjetit: string
          id: number
          items: Json
          notes: string | null
          photo_base64: string | null
          total_price: number
          vehicle_id: number
        }
        Insert: {
          created_at?: string | null
          date: string
          emri_mjetit: string
          id?: never
          items?: Json
          notes?: string | null
          photo_base64?: string | null
          total_price: number
          vehicle_id: number
        }
        Update: {
          created_at?: string | null
          date?: string
          emri_mjetit?: string
          id?: never
          items?: Json
          notes?: string | null
          photo_base64?: string | null
          total_price?: number
          vehicle_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_services_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          archived_at: string | null
          created_at: string
          emri_mjetit: string
          id: number
          registration_expires_at: string | null
          targa: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          emri_mjetit: string
          id?: number
          registration_expires_at?: string | null
          targa: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          emri_mjetit?: string
          id?: number
          registration_expires_at?: string | null
          targa?: string
        }
        Relationships: []
      }
      worker_payments: {
        Row: {
          amount: number
          created_at: string
          date: string
          employee_id: number
          emri: string
          id: number
          mbiemri: string
          pershkrim: string
        }
        Insert: {
          amount: number
          created_at?: string
          date: string
          employee_id: number
          emri: string
          id?: number
          mbiemri: string
          pershkrim: string
        }
        Update: {
          amount?: number
          created_at?: string
          date?: string
          employee_id?: number
          emri?: string
          id?: number
          mbiemri?: string
          pershkrim?: string
        }
        Relationships: [
          {
            foreignKeyName: "worker_payments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
