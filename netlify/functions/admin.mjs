// Netlify entry point. The logic lives in api/admin.js and is shared with Vercel.
import handler from "../../api/admin.js";
import { adapt } from "../lib/adapter.js";

export default adapt(handler);

export const config = { path: "/api/admin" };
