// Use apenas se o projeto ainda não possuir @/lib/utils.
// O shadcn normalmente já cria esta função.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
