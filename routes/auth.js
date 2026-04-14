const express = require('express');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

function buildReferralCode() {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
}

function getSafeRedirectPath(req, fallback = '/dashboard') {
    const sessionRedirect = typeof req.session?.returnTo === 'string' ? req.session.returnTo : '';
    if (req.session && Object.prototype.hasOwnProperty.call(req.session, 'returnTo')) {
        delete req.session.returnTo;
    }
    const candidate = sessionRedirect || fallback;
    if (!candidate.startsWith('/') || candidate.startsWith('//')) {
        return fallback;
    }
    return candidate;
}

module.exports = function createAuthRouter({
    passport,
    queryOne,
    queryRun,
    hashPassword,
    randomPassword,
    sanitizeEmail,
    updateUserLastLogin,
    updateUserLoginAttempts,
    googleClientId,
    googleClientSecret,
    googleCallbackUrl
}) {
    const router = express.Router();
    const googleConfigured = Boolean(googleClientId && googleClientSecret && googleCallbackUrl);

    passport.serializeUser((user, done) => {
        done(null, user.id);
    });

    passport.deserializeUser(async (id, done) => {
        try {
            const user = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
            done(null, user || false);
        } catch (err) {
            done(err);
        }
    });

    if (googleConfigured) {
        passport.use(new GoogleStrategy(
            {
                clientID: googleClientId,
                clientSecret: googleClientSecret,
                callbackURL: googleCallbackUrl
            },
            async (_accessToken, _refreshToken, profile, done) => {
                try {
                    const googleId = String(profile?.id || '').trim();
                    const email = sanitizeEmail(profile?.emails?.[0]?.value || '');
                    const displayName = String(profile?.displayName || email.split('@')[0] || 'Google User').trim();
                    const photo = String(profile?.photos?.[0]?.value || '').trim() || null;

                    if (!googleId) {
                        return done(null, false, { message: 'invalid_profile' });
                    }

                    if (!email) {
                        return done(null, false, { message: 'no_email' });
                    }

                    let user = await queryOne('SELECT * FROM users WHERE "googleId" = $1', [googleId]);
                    if (!user) {
                        user = await queryOne('SELECT * FROM users WHERE email = $1', [email]);
                    }

                    if (user) {
                        if (!user.is_active) {
                            return done(null, false, { message: 'account_blocked' });
                        }

                        await queryRun(
                            "UPDATE users SET \"googleId\" = COALESCE(\"googleId\", $1), \"displayName\" = $2, \"photo\" = $3, name = COALESCE(NULLIF(TRIM(name), ''), $2) WHERE id = $4",
                            [googleId, displayName, photo, user.id]
                        );

                        await updateUserLastLogin(user.id);
                        await updateUserLoginAttempts(user.id, 0);

                        const refreshedUser = await queryOne('SELECT * FROM users WHERE id = $1', [user.id]);
                        return done(null, refreshedUser);
                    }

                    const hashedPassword = await hashPassword(randomPassword());
                    const referralCode = buildReferralCode();
                    const createdUser = await queryOne(
                        'INSERT INTO users (email, password, name, referral_code, "googleId", "displayName", "photo") VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                        [email, hashedPassword, displayName, referralCode, googleId, displayName, photo]
                    );

                    if (!createdUser) {
                        return done(null, false, { message: 'user_create_failed' });
                    }

                    await updateUserLastLogin(createdUser.id);
                    await updateUserLoginAttempts(createdUser.id, 0);
                    return done(null, createdUser);
                } catch (err) {
                    return done(err);
                }
            }
        ));
    }

    router.get('/google', (req, res, next) => {
        if (!googleConfigured) {
            return res.status(500).send('Google login not configured');
        }

        return passport.authenticate('google', {
            scope: ['profile', 'email'],
            prompt: 'select_account'
        })(req, res, next);
    });

    router.get('/google/callback', (req, res, next) => {
        if (!googleConfigured) {
            return res.status(500).send('Google login not configured');
        }

        return passport.authenticate('google', (err, user, info) => {
            if (err) {
                return res.redirect('/?google_error=oauth_failed');
            }

            if (!user) {
                const errorCode = info?.message || 'oauth_failed';
                return res.redirect(`/?google_error=${encodeURIComponent(errorCode)}`);
            }

            req.session.regenerate((regenErr) => {
                if (regenErr) {
                    return res.redirect('/?google_error=session_failed');
                }

                return req.logIn(user, (loginErr) => {
                    if (loginErr) {
                        return res.redirect('/?google_error=session_failed');
                    }

                    req.session.userId = user.id;
                    return req.session.save((saveErr) => {
                        if (saveErr) {
                            return res.redirect('/?google_error=session_save_failed');
                        }
                        const redirectPath = getSafeRedirectPath(req);
                        return res.redirect(redirectPath);
                    });
                });
            });
        })(req, res, next);
    });

    return router;
};