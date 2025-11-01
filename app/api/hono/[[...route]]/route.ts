import app from "@/lib/api/app";

const handler = (request: Request) => app.fetch(request);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const OPTIONS = handler;
