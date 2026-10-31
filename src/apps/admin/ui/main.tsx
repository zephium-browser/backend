import { render } from "preact";
import { App } from "./App";
import { applyTheme, readTheme } from "./theme";

applyTheme(readTheme());
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
render(<App />, root);
