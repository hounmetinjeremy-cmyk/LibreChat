import type { TStartupConfig } from 'librechat-data-provider';
import { GoogleIcon } from '@librechat/client';

/** Page de connexion : un seul bouton bleu « Se connecter avec Google ». */
function SocialLoginRender({
  startupConfig,
}: {
  startupConfig: TStartupConfig | null | undefined;
}) {
  const serverDomain = startupConfig?.serverDomain ?? '';

  return (
    <div className="mt-8 w-full">
      <a
        href={`${serverDomain}/oauth/google`}
        id="google"
        className="flex w-full items-center justify-center gap-3 rounded-xl bg-blue-600 px-5 py-3.5 text-base font-semibold text-white transition-colors duration-200 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white">
          <GoogleIcon />
        </span>
        Se connecter avec Google
      </a>
    </div>
  );
}

export default SocialLoginRender;
