// =============================================================================
// Telefone BR — separação entre CAMADA DE EXIBIÇÃO e CAMADA DE ARMAZENAMENTO
// =============================================================================
// EXIBIÇÃO  : o que o usuário vê/edita no input, em formato nacional mascarado:
//             "(51) 98456-7711" (celular) ou "(51) 3456-7890" (fixo).
// ARMAZENAMENTO: o que vai ao banco — apenas dígitos, com DDI 55 na frente e
//             sem símbolos: "5551984567711".
//
// O input SEMPRE trabalha em formato nacional (DDD + número, no máx. 11 dígitos);
// o código do país (55) só é adicionado na hora de salvar e removido na hora de
// exibir. Assim as duas camadas nunca se misturam.
// =============================================================================

// DDDs válidos no Brasil (Anatel).
const DDDS_VALIDOS = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

function apenasDigitos(valor: string): string {
  return valor.replace(/\D/g, "");
}

// Extrai a parte NACIONAL (DDD + número) de uma string qualquer, removendo o
// código do país 55 quando presente (valor armazenado tem 12 ou 13 dígitos).
function nacional(valor: string): string {
  let d = apenasDigitos(valor);
  if (d.length > 11 && d.startsWith("55")) {
    d = d.slice(2);
  }
  return d.slice(0, 11);
}

// Formata dígitos nacionais (até 11) na máscara brasileira, progressivamente.
// O traço só "reflui" para 5-4 quando o 11º dígito (celular) é digitado.
function formatarNacional(digitosNacionais: string): string {
  const d = digitosNacionais.slice(0, 11);
  if (d.length === 0) return "";
  if (d.length <= 2) return `(${d}`;

  const ddd = d.slice(0, 2);
  const resto = d.slice(2);

  if (resto.length <= 4) return `(${ddd}) ${resto}`;
  if (d.length <= 10) {
    // Fixo: número de 8 dígitos -> 4-4.
    return `(${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
  }
  // Celular: número de 9 dígitos -> 5-4.
  return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
}

// Para o onChange do input: mascara o que o usuário digita.
export function mascararTelefone(input: string): string {
  return formatarNacional(nacional(input));
}

// Valor armazenado -> string mascarada para exibir/editar.
export function telefoneParaExibicao(armazenado: string): string {
  return formatarNacional(nacional(armazenado));
}

// String mascarada (nacional) -> valor de armazenamento (55 + dígitos).
export function telefoneParaArmazenamento(display: string): string {
  const d = apenasDigitos(display);
  // Já inclui o código do país (12/13 dígitos começando com 55): não duplica.
  if (d.length > 11 && d.startsWith("55")) {
    return d;
  }
  // Caso normal: usuário digitou só DDD + número -> adiciona o 55.
  return `55${d}`;
}

// Valida: DDD válido + número com 8 (fixo) ou 9 (celular) dígitos. Celular deve
// começar com 9. Aceita tanto o formato mascarado quanto dígitos crus.
export function validarTelefoneBR(valor: string): boolean {
  const d = nacional(valor);
  if (d.length !== 10 && d.length !== 11) return false;

  const ddd = d.slice(0, 2);
  if (!DDDS_VALIDOS.has(ddd)) return false;

  const numero = d.slice(2);
  if (numero.length !== 8 && numero.length !== 9) return false;
  if (numero.length === 9 && numero[0] !== "9") return false;

  return true;
}
