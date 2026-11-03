# mcp_jtc — SAP ADT MCP Server (sap-adt)

MCP Just Time Consulting Factory. Servidor MCP que conecta **Claude** (Claude Desktop / Cowork) con SAP vía la API ADT (ABAP Development Tools): leer y escribir código ABAP, buscar objetos, transportes, ATC, ABAP Unit, dumps, data preview y más. 39 herramientas.

## Requisitos

- Windows con **Node.js 18+** (`node -v`)
- **Git**
- Claude Desktop
- Acceso de red al sistema SAP (VPN si aplica)
- Usuario SAP con autorización ADT

## Instalación

1. **Clonar e instalar dependencias** (PowerShell):

   ```powershell
   cd C:\MCP
   git clone https://github.com/mhaopacheco/mcp_jtc.git
   cd mcp_jtc
   npm install
   ```

2. **Configurar la conexión SAP**: copia `.env.example` como `.env` y pon tu usuario y contraseña:

   ```powershell
   copy .env.example .env
   notepad .env
   ```

   ```env
   SAP_CONNECTIONS=[{"alias":"DEV","host":"18.219.205.131","port":"44300","protocol":"https","client":"100","user":"TU_USUARIO","password":"TU_CONTRASENA"}]
   ```

   - El JSON va en **una sola línea**.
   - Varias conexiones: agrega más objetos al arreglo y cambia con `sap_switch_client`.
   - El `.env` está en `.gitignore`: **nunca lo subas al repositorio**.

3. **Registrar el servidor en Claude Desktop**: abre `%APPDATA%\Claude\claude_desktop_config.json` (en Claude: Configuración → Desarrollador → Editar configuración) y agrega dentro de `mcpServers`:

   ```json
   "sap-adt": {
     "command": "node",
     "args": ["C:\\MCP\\mcp_jtc\\index.js"]
   }
   ```

   Ajusta la ruta si clonaste en otra carpeta. No pongas credenciales aquí: el servidor lee el `.env` de su propia carpeta, y el `.env` tiene prioridad sobre un bloque `env` en esta configuración.

4. **Reiniciar Claude Desktop por completo**: clic derecho en el ícono junto al reloj → *Quit*, y ábrelo de nuevo.

5. **Probar**: pídele a Claude *"haz un sap_ping con sap-adt"*. Debe responder `✅ Conexión exitosa con SAP!`.

## Actualizar

```powershell
cd C:\MCP\mcp_jtc
git pull
npm install
```

Luego reinicia Claude Desktop.

## Herramientas

| Grupo | Herramientas |
|---|---|
| Conexión | `sap_ping`, `sap_system_info`, `sap_list_connections`, `sap_switch_client` |
| Búsqueda | `sap_search_objects`, `sap_text_search`, `sap_where_used`, `sap_list_package` |
| Lectura | `sap_read_program`, `sap_read_class`, `sap_read_function_group`, `sap_read_cds_view`, `sap_read_badi` |
| Diccionario / datos | `sap_read_ddic_table`, `sap_read_ddic_element`, `sap_read_table`, `sap_data_preview` |
| Creación | `sap_create_program`, `sap_create_abap_program`, `sap_create_class`, `sap_create_interface`, `sap_create_function_group`, `sap_create_cds_view`, `sap_create_ddic_table` |
| Escritura / activación | `sap_write_source`, `sap_deploy_object`, `sap_activate`, `sap_activate_object`, `sap_write_test` |
| Calidad | `sap_check_syntax`, `sap_run_atc`, `sap_abap_unit`, `sap_pretty_print` |
| Transportes | `sap_list_my_transports`, `sap_read_transport` |
| Diagnóstico | `sap_list_dumps`, `sap_read_dump`, `sap_abap_trace` |
| Fiori | `sap_list_fiori_pages` |

## Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| sap-adt en "Connection closed" / "failed" | Falta el `.env` o el JSON de `SAP_CONNECTIONS` es inválido | Revisa el `.env` (una línea, comillas dobles) y reinicia Claude |
| `401` en `sap_ping` | Usuario o contraseña incorrectos | Corrige el `.env` y reinicia Claude |
| `ETIMEDOUT` / `ECONNREFUSED` | Sin red/VPN hacia SAP o puerto incorrecto | Conecta la VPN y verifica host y puerto |
| Cambios en `.env` no se aplican | Claude no relanza el servidor solo | Cierra Claude por completo y ábrelo de nuevo |

Probar el servidor a mano (debe imprimir `SAP ADT MCP Server ... iniciado`; sal con Ctrl+C):

```powershell
node C:\MCP\mcp_jtc\index.js
```

## Notas

- Certificados self-signed: por defecto no se valida el certificado TLS. Para validarlo, agrega `SAP_TLS_REJECT_UNAUTHORIZED=true` al `.env`.
- Cambios recientes (2026-11-03): el `.env` se lee desde la carpeta del script (antes fallaba al lanzarlo desde Claude Desktop) y se corrigió el parseo de resultados en `sap_search_objects` y otras dos herramientas que devolvían listas vacías.
