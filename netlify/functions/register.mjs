// Netlify entry point. The logic lives in api/register.js and is shared with Vercel.
import handler from "../../api/register.js";
import { adapt } from "../lib/adapter.js";

export default adapt(handler);

// Functions v2 routes itself — no redirect rules needed.
export const config = { path: "/api/register" };
