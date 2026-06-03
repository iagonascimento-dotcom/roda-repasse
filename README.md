# Roda Repasse

Sistema de cálculo e gestão de repasse para PDVs — Roda Conveniência.

## Como colocar online (GitHub Pages — grátis)

### 1. Criar repositório no GitHub
- Vá em [github.com/new](https://github.com/new)
- Nome: `roda-repasse` (ou o que quiser)
- Deixe **público** ou privado
- **NÃO** marque "Add a README"
- Clique **Create repository**

### 2. Subir o código
Descompacte o ZIP, abra o terminal na pasta e rode:

```bash
git init
git add .
git commit -m "feat: sistema de repasse v2 com Supabase"
git remote add origin https://github.com/SEU-USUARIO/roda-repasse.git
git branch -M main
git push -u origin main
```

### 3. Ativar GitHub Pages
- No repositório, vá em **Settings → Pages**
- Em **Source**, selecione **GitHub Actions**
- O deploy roda automaticamente a cada push

### 4. Acessar
Em ~2 minutos, seu site fica disponível em:
`https://SEU-USUARIO.github.io/roda-repasse/`

## Login
- **Email:** admin@roda.com
- **Senha:** roda2025

## Desenvolvimento local

```bash
npm install
npm run dev
```

Abre em `http://localhost:5173`

## Stack
- React 18 + Vite
- Supabase (PostgreSQL + Auth)
- GitHub Pages (hospedagem)
