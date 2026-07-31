"use client";

export function ConsoleLoading() {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 min-h-screen">
      <div className="h-10 w-10 rounded-full border-2 border-muted border-t-foreground animate-spin" />
      <p className="text-sm text-muted-foreground font-mono">Loading...</p>
    </div>
  );
}
