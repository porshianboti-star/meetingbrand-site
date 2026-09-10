-- CompanyCard signup trigger + ONE early return for MeetingBrand signups (generated from the live definition, 2026-09-10)
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_company  uuid;
  v_role     text := 'employee';
  v_token    uuid;
  v_invite   public.invites%rowtype;
begin
  if coalesce(new.raw_user_meta_data->>'product', '') = 'meetingbrand' then
    return new;   -- MeetingBrand signup: handled by mb.handle_new_user (trigger mb_on_auth_user_created)
  end if;
  if new.raw_user_meta_data ? 'invite_token' then
    v_token := (new.raw_user_meta_data->>'invite_token')::uuid;
    select * into v_invite from public.invites
      where token = v_token and accepted_at is null and expires_at > now();
    if v_invite.id is null then
      raise exception 'Invite link is invalid or has expired';
    end if;
    v_company := v_invite.company_id;
    v_role    := v_invite.role;
    update public.invites
      set accepted_by = new.id, accepted_at = now() where id = v_invite.id;
  elsif new.raw_user_meta_data ? 'company_name' then
    insert into public.companies (name)
      values (coalesce(nullif(trim(new.raw_user_meta_data->>'company_name'), ''), 'My company'))
      returning id into v_company;
    v_role := 'admin';
  else
    raise exception 'Signup requires a company name or an invite';
  end if;

  insert into public.profiles (id, company_id, role, full_name, email)
  values (new.id, v_company, v_role,
          new.raw_user_meta_data->>'full_name', new.email);
  return new;
end $function$;
