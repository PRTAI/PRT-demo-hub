export const businessOwnerRoles = ['business'];
export const developmentOwnerRoles = ['employee', 'supervisor', 'pm'];

export function defaultResponsibility(roles) {
  const business = roles.some(role => businessOwnerRoles.includes(role));
  const development = roles.some(role => developmentOwnerRoles.includes(role));
  return business ? development ? 'both' : 'business' : 'development';
}

export function splitRequirementOwners(users) {
  return {
    businessOwners: users.filter(user => ['business', 'both'].includes(user.responsibility)),
    developmentOwners: users.filter(user => ['development', 'both'].includes(user.responsibility))
  };
}
